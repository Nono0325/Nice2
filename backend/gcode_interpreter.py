import re
import time
import logging
import threading
from typing import Dict, Any, List, Optional

logger = logging.getLogger("GCodeInterpreter")

class GCodeCommand:
    """單行 G-Code 指令解析實體"""
    def __init__(self, raw_line: str, line_number: int):
        self.raw_line: str = raw_line.strip()
        self.line_number: int = line_number
        self.cmd: str = ""                   # 如 "G0", "G1", "M3", "G28"
        self.params: Dict[str, float] = {}   # 如 {"X": 10.0, "Z": 5.0, "F": 1200.0}
        self.comment: str = ""
        self._parse()

    def _parse(self):
        line = self.raw_line
        # 移除分號註解
        if ";" in line:
            parts = line.split(";", 1)
            line = parts[0].strip()
            self.comment = parts[1].strip()
        # 移除圓括號註解
        line = re.sub(r'\(.*?\)', '', line).strip()

        if not line:
            return

        tokens = line.split()
        if not tokens:
            return

        # 略過行號 N標籤 (如 N10 G1 X50)
        start_idx = 0
        if tokens[0].upper().startswith("N") and len(tokens[0]) > 1 and tokens[0][1:].isdigit():
            start_idx = 1

        if start_idx >= len(tokens):
            return

        # 解析首個命令代碼 (Gxx, Mxx)
        first_token = tokens[start_idx].upper()
        match = re.match(r'^([A-Z])([0-9\.]+)$', first_token)
        if match:
            letter, num_str = match.groups()
            cmd_num = int(float(num_str)) if '.' not in num_str else num_str
            self.cmd = f"{letter}{cmd_num}"
            start_idx += 1
        else:
            return

        # 解析後續參數
        for token in tokens[start_idx:]:
            token = token.upper()
            m = re.match(r'^([A-Z])([-+]?[0-9]*\.?[0-9]+)$', token)
            if m:
                p_letter, p_val = m.groups()
                self.params[p_letter] = float(p_val)
            elif re.match(r'^[A-Z]$', token):
                # 支援無數值之單字母標記 (例如 G28 X 或 G28 Z)
                self.params[token] = 1.0

    @property
    def is_empty(self) -> bool:
        return not self.cmd

    def __repr__(self):
        return f"<GCodeLine #{self.line_number}: {self.cmd} {self.params} (comment: {self.comment})>"


class GCodeInterpreter:
    """
    雙軸龍門機械手臂 G-Code 解譯器與自動化執行引擎
    支援完整標準指令集、即時 MDI 單行指令、多行腳本背景執行、暫停/繼續/中斷與進度追蹤
    """
    def __init__(self, motion_engine):
        self.motion_engine = motion_engine
        
        # 模態狀態 (Modal State)
        self.distance_mode: str = "G90"      # "G90" 絕對座標, "G91" 相對座標
        self.unit_scale: float = 1.0         # G21=1.0 (mm), G20=25.4 (inch)
        self.feedrate: float = 1800.0        # 當前進給率 (mm/min, 預設 1800 = 30 mm/s)
        
        # 腳本執行管理
        self.state: str = "IDLE"             # "IDLE", "RUNNING", "PAUSED", "STOPPED", "COMPLETED", "ERROR"
        self.program_lines: List[GCodeCommand] = []
        self.current_line_idx: int = 0
        self.total_lines: int = 0
        self.start_time: float = 0.0
        self.elapsed_seconds: float = 0.0
        self.current_cmd_str: str = ""
        self.last_error: str = ""
        
        # 執行緒與同步旗標
        self._worker_thread: Optional[threading.Thread] = None
        self._pause_event = threading.Event()
        self._pause_event.set()  # 初始不暫停 (Set = 運行中)
        self._stop_requested = False
        # 歷史記錄 (保留最近 50 筆執行紀錄)
        self.history_logs: List[Dict[str, Any]] = []
        self._history_lock = threading.RLock()
        self._lock = threading.RLock()

    def _convert_feedrate(self, f_val: float) -> float:
        """轉換進給率為後端 mm/s 速度 (若 > 150 視為標準 G-Code mm/min，否則視為 mm/s)"""
        if f_val > 150.0:
            return max(1.0, f_val / 60.0)
        return max(1.0, f_val)

    def _add_log(self, text: str, status: str = "ok"):
        """記錄單步執行日誌"""
        with self._history_lock:
            self.history_logs.append({
                "time": time.strftime("%H:%M:%S"),
                "text": text,
                "status": status
            })
            if len(self.history_logs) > 60:
                self.history_logs.pop(0)

    def execute_line(self, line_text: str) -> Dict[str, Any]:
        """
        即時執行單行 G-Code 指令 (MDI 手動輸入模式)
        """
        cmd_obj = GCodeCommand(line_text, 0)
        if cmd_obj.is_empty:
            return {"status": "ok", "message": "空白或註解行", "response": ""}
        
        res = self._execute_single_command(cmd_obj)
        self._add_log(f"{cmd_obj.raw_line} -> {res.get('message', 'OK')}", res.get("status", "ok"))
        return res

    def _execute_single_command(self, cmd_obj: GCodeCommand) -> Dict[str, Any]:
        """核心指令分發器"""
        cmd = cmd_obj.cmd
        params = cmd_obj.params

        # --- G0 / G1: 座標定位與直線插補 ---
        if cmd in ["G0", "G1", "G00", "G01"]:
            # 更新進給速度 F
            if "F" in params:
                self.feedrate = params["F"]
            speed_mm_s = self._convert_feedrate(self.feedrate)

            # 解析目標座標
            if self.distance_mode == "G90":
                # 絕對座標模式
                target_x = (params["X"] * self.unit_scale) if "X" in params else None
                target_z = (params["Z"] * self.unit_scale) if "Z" in params else None
                if target_x is None and target_z is None:
                    return {"status": "ok", "message": f"設定進給率 F={self.feedrate}"}
                
                success = self.motion_engine.move_sync(x=target_x, z=target_z, speed=speed_mm_s)
                if not success:
                    return {"status": "error", "message": f"移動至 X={target_x} Z={target_z} 失敗或中斷"}
                return {"status": "ok", "message": f"移至 X={target_x} Z={target_z} (速度 {speed_mm_s:.1f}mm/s)"}
            else:
                # 相對座標模式 (G91)
                dx = (params["X"] * self.unit_scale) if "X" in params else None
                dz = (params["Z"] * self.unit_scale) if "Z" in params else None
                if dx is None and dz is None:
                    return {"status": "ok", "message": f"設定進給率 F={self.feedrate}"}

                success = self.motion_engine.move_rel_sync(dx=dx, dz=dz, speed=speed_mm_s)
                if not success:
                    return {"status": "error", "message": f"相對移動 dX={dx} dZ={dz} 失敗或中斷"}
                return {"status": "ok", "message": f"相對移動 dX={dx} dZ={dz} (速度 {speed_mm_s:.1f}mm/s)"}

        # --- G4: 延時等待 (Dwell) ---
        elif cmd in ["G4", "G04"]:
            delay_sec = 0.0
            if "S" in params:
                delay_sec = params["S"]
            elif "P" in params:
                p_val = params["P"]
                delay_sec = (p_val / 1000.0) if p_val >= 100.0 else p_val
            
            end_t = time.time() + delay_sec
            while time.time() < end_t:
                if self._stop_requested:
                    return {"status": "stopped", "message": "延時被使用者中止"}
                time.sleep(0.02)
            return {"status": "ok", "message": f"延時暫停 {delay_sec:.2f} 秒完成"}

        # --- G20 / G21: 單位設定 ---
        elif cmd == "G20":
            self.unit_scale = 25.4
            return {"status": "ok", "message": "設定單位為英吋 (Inch)"}
        elif cmd == "G21":
            self.unit_scale = 1.0
            return {"status": "ok", "message": "設定單位為公釐 (mm)"}

        # --- G28: 全自動歸零 ---
        elif cmd == "G28":
            target_axes = "ALL"
            has_x = "X" in params
            has_z = "Z" in params
            if has_x and not has_z:
                target_axes = "X"
            elif has_z and not has_x:
                target_axes = "Z"
            
            success = self.motion_engine.homing_sync(axes=target_axes)
            if not success:
                return {"status": "error", "message": f"{target_axes} 軸原點歸零失敗"}
            return {"status": "ok", "message": f"{target_axes} 軸自動原點復歸完成"}

        # --- G90 / G91: 座標模式切換 ---
        elif cmd == "G90":
            self.distance_mode = "G90"
            return {"status": "ok", "message": "模式切換: 絕對座標 (Absolute Distance Mode)"}
        elif cmd == "G91":
            self.distance_mode = "G91"
            return {"status": "ok", "message": "模式切換: 相對增量座標 (Incremental Distance Mode)"}

        # --- G92: 設定座標偏置 / 原點重設 ---
        elif cmd == "G92":
            resp_parts = []
            if "X" in params:
                val_x = params["X"] * self.unit_scale
                self.motion_engine.motor_x.set_position_mm(val_x)
                resp_parts.append(f"X={val_x:.2f}")
            if "Z" in params:
                val_z = params["Z"] * self.unit_scale
                self.motion_engine.motor_z.set_position_mm(val_z)
                resp_parts.append(f"Z={val_z:.2f}")
            return {"status": "ok", "message": f"座標校準更新: {', '.join(resp_parts)}"}

        # --- M3: 開啟電磁鐵吸附 ---
        elif cmd in ["M3", "M03"]:
            if "P" in params:
                ch = int(params["P"])
                self.motion_engine.electromagnets.set_channel(ch, True)
                return {"status": "ok", "message": f"電磁鐵 EM{ch} -> 開啟 (吸附中)"}
            else:
                self.motion_engine.electromagnets.set_all(True)
                return {"status": "ok", "message": "全部電磁鐵 -> 開啟 (吸附中)"}

        # --- M5: 關閉電磁鐵釋放 ---
        elif cmd in ["M5", "M05"]:
            if "P" in params:
                ch = int(params["P"])
                self.motion_engine.electromagnets.set_channel(ch, False)
                return {"status": "ok", "message": f"電磁鐵 EM{ch} -> 關閉 (釋放)"}
            else:
                self.motion_engine.electromagnets.set_all(False)
                return {"status": "ok", "message": "全部電磁鐵 -> 關閉 (釋放)"}

        # --- M17: 致能馬達鎖定 ---
        elif cmd == "M17":
            self.motion_engine.set_motor_lock("ALL", True)
            return {"status": "ok", "message": "全軸馬達已致能鎖定 (保持扭矩)"}

        # --- M18 / M84: 離合釋放馬達 ---
        elif cmd in ["M18", "M84"]:
            self.motion_engine.set_motor_lock("ALL", False)
            return {"status": "ok", "message": "全軸馬達已離合釋放 (線圈無電流)"}

        # --- M112: 緊急停止 ---
        elif cmd == "M112":
            self.motion_engine.emergency_stop()
            self.stop_program()
            return {"status": "error", "message": "緊急煞車 E-STOP 已觸發！"}

        # --- M114: 查詢當前軸座標 ---
        elif cmd == "M114":
            cur_x = self.motion_engine.motor_x.position_mm
            cur_z = self.motion_engine.motor_z.position_mm
            msg = f"X:{cur_x:.3f} Z:{cur_z:.3f} Feedrate:{self.feedrate}"
            return {"status": "ok", "message": msg, "response": msg}

        # --- M119: 查詢限位感測器狀態 ---
        elif cmd == "M119":
            s = self.motion_engine.sensor_monitor.read_all()
            summary = (
                f"X_Left:{'TRIG' if s.get('x_left') else 'OPEN'} "
                f"X_Mid:{'TRIG' if s.get('x_mid') else 'OPEN'} "
                f"X_Right:{'TRIG' if s.get('x_right') else 'OPEN'} "
                f"Z_Up:{'TRIG' if s.get('z_up') else 'OPEN'} "
                f"Z_Down:{'TRIG' if s.get('z_down') else 'OPEN'}"
            )
            return {"status": "ok", "message": summary, "response": summary}

        # --- M0 / M1: 程式暫停 ---
        elif cmd in ["M0", "M1"]:
            self.pause_program()
            return {"status": "ok", "message": "程式指令暫停中 (等待使用者繼續)"}

        # --- M2 / M30: 程式結束 ---
        elif cmd in ["M2", "M30"]:
            return {"status": "ok", "message": "G-Code 程式正常結束"}

        else:
            logger.warning(f"未支援或忽略之 G/M 碼: {cmd}")
            return {"status": "ok", "message": f"略過未定義指令 {cmd}"}

    # ==========================================
    # 多行 G-Code 腳本排程與自動化執行
    # ==========================================

    def load_program(self, gcode_text: str) -> Dict[str, Any]:
        """載入多行 G-Code 腳本並進行前置語法驗證"""
        with self._lock:
            if self.state == "RUNNING":
                return {"status": "error", "message": "目前有 G-Code 程式執行中，請先停止"}
            
            lines = gcode_text.splitlines()
            parsed: List[GCodeCommand] = []
            for idx, l in enumerate(lines):
                cmd = GCodeCommand(l, idx + 1)
                if not cmd.is_empty:
                    parsed.append(cmd)
            
            self.program_lines = parsed
            self.current_line_idx = 0
            self.total_lines = len(parsed)
            self.state = "IDLE"
            self.current_cmd_str = ""
            self.elapsed_seconds = 0.0
            self.last_error = ""
            logger.info(f"已成功載入 G-Code 程式，有效指令行數: {self.total_lines}")
            return {"status": "ok", "total_lines": self.total_lines}

    def start_program(self, gcode_text: Optional[str] = None) -> Dict[str, Any]:
        """啟動 G-Code 程式"""
        with self._lock:
            if self.state == "RUNNING":
                return {"status": "error", "message": "程式已在運轉中"}
            
            if gcode_text is not None:
                res = self.load_program(gcode_text)
                if res.get("status") == "error":
                    return res

            if not self.program_lines:
                return {"status": "error", "message": "G-Code 腳本內容為空，無法執行"}

            self._stop_requested = False
            self._pause_event.set()
            self.state = "RUNNING"
            self.current_line_idx = 0
            self.start_time = time.time()
            self.last_error = ""

            self._worker_thread = threading.Thread(target=self._run_program_loop, daemon=True)
            self._worker_thread.start()
            logger.info(">>> G-Code 自動化執行緒已啟動")
            return {"status": "ok", "message": "G-Code 程式已啟動執行"}

    def pause_program(self) -> Dict[str, Any]:
        """暫停當前 G-Code 執行"""
        if self.state != "RUNNING":
            return {"status": "error", "message": "目前並未處於運轉狀態"}
        self._pause_event.clear()
        self.state = "PAUSED"
        logger.info("|| G-Code 程式已暫停")
        return {"status": "ok", "message": "程式已暫停"}

    def resume_program(self) -> Dict[str, Any]:
        """繼續已暫停的 G-Code 執行"""
        if self.state != "PAUSED":
            return {"status": "error", "message": "目前非暫停狀態"}
        self._pause_event.set()
        self.state = "RUNNING"
        logger.info("▶ G-Code 程式繼續執行")
        return {"status": "ok", "message": "程式已恢復執行"}

    def stop_program(self) -> Dict[str, Any]:
        """中止停止當前 G-Code 執行"""
        self._stop_requested = True
        self._pause_event.set()  # 解除暫停阻塞以允許執行緒退出
        self.motion_engine.motor_x.abort()
        self.motion_engine.motor_z.abort()
        self.state = "STOPPED"
        logger.warning("■ G-Code 程式已被使用者中止！")
        return {"status": "ok", "message": "G-Code 程式已中止"}

    def _run_program_loop(self):
        """背景執行緒：循序逐行執行 G-Code 指令"""
        logger.info(f"開始執行 G-Code 序列，總行數: {self.total_lines}")
        try:
            for idx, cmd in enumerate(self.program_lines):
                # 檢測中斷請求
                if self._stop_requested:
                    self.state = "STOPPED"
                    break

                # 處理暫停等待
                self._pause_event.wait()
                if self._stop_requested:
                    self.state = "STOPPED"
                    break

                self.current_line_idx = idx + 1
                self.current_cmd_str = cmd.raw_line
                self.elapsed_seconds = round(time.time() - self.start_time, 1)

                # 執行單步指令
                res = self._execute_single_command(cmd)
                self._add_log(f"[{cmd.line_number}] {cmd.raw_line} -> {res.get('message', 'OK')}", res.get("status", "ok"))

                if res.get("status") == "error":
                    self.state = "ERROR"
                    self.last_error = f"行 #{cmd.line_number} 執行失敗: {res.get('message')}"
                    logger.error(self.last_error)
                    break
                elif res.get("status") == "stopped":
                    self.state = "STOPPED"
                    break

                # 遇到 M2 / M30 結束指令提早結束
                if cmd.cmd in ["M2", "M30"]:
                    break

            if self.state == "RUNNING":
                self.state = "COMPLETED"
                logger.info("=== G-Code 程式圓滿執行完成！===")
        except Exception as e:
            self.state = "ERROR"
            self.last_error = f"G-Code 執行異常: {e}"
            logger.error(self.last_error)
        finally:
            self.elapsed_seconds = round(time.time() - self.start_time, 1)
            self.current_cmd_str = ""

    def get_status(self) -> Dict[str, Any]:
        """返回 G-Code 引擎目前狀態與進度資料 (遙測與 API 專用)"""
        pct = 0.0
        if self.total_lines > 0:
            pct = round((self.current_line_idx / self.total_lines) * 100.0, 1)
        
        current_elapsed = self.elapsed_seconds
        if self.state == "RUNNING" and self.start_time > 0:
            current_elapsed = round(time.time() - self.start_time, 1)

        with self._history_lock:
            recent_logs = list(self.history_logs[-20:])

        return {
            "state": self.state,
            "current_line": self.current_line_idx,
            "total_lines": self.total_lines,
            "progress_percent": pct,
            "current_command": self.current_cmd_str,
            "distance_mode": self.distance_mode,
            "feedrate": self.feedrate,
            "speed_mm_s": round(self._convert_feedrate(self.feedrate), 1),
            "unit": "mm" if self.unit_scale == 1.0 else "inch",
            "elapsed_seconds": current_elapsed,
            "last_error": self.last_error,
            "recent_logs": recent_logs
        }
