// 雙軸龍門控制系統前端邏輯 (Vue 3 輕量響應式架構)
const { createApp, ref, reactive, computed, onMounted, onUnmounted } = Vue;

createApp({
  setup() {
    // 導航分頁
    const currentTab = ref('cockpit'); // cockpit, sensors, motors, system

    // 即時遙測數據 (由 WebSocket 頻繁更新)
    const telemetry = reactive({
      state: 'IDLE',
      is_simulation: false,
      motor_x: {
        name: 'X軸馬達',
        position_mm: 0.0,
        position_steps: 0,
        is_locked: true,
        is_moving: false,
        is_homed: false,
        steps_per_mm: 40.0,
        max_speed: 120.0,
        min_limit_mm: 0.0,
        max_limit_mm: 600.0
      },
      motor_z: {
        name: 'Z軸馬達',
        position_mm: 0.0,
        position_steps: 0,
        is_locked: true,
        is_moving: false,
        is_homed: false,
        steps_per_mm: 320.0,
        max_speed: 40.0,
        min_limit_mm: 0.0,
        max_limit_mm: 30.0
      },
      sensors: {
        x_left: false,
        x_mid: false,
        x_right: false,
        z_up: false,
        z_down: false,
        arm_1: false, arm_2: false, arm_3: false, arm_4: false,
        arm_5: false, arm_6: false, arm_7: false, arm_8: false,
        x_alm: false,
        z_alm: false,
        summary: {
          x_limits: { left: false, mid: false, right: false },
          z_limits: { up: false, down: false },
          arm_sensors: [false, false, false, false, false, false, false, false],
          alarms: { x_alm: false, z_alm: false }
        }
      },
      electromagnets: {
        em1: false,
        em2: false,
        em3: false,
        em4: false,
        any_active: false
      },
      system: {
        cpu_percent: 0,
        cpu_temp_c: 0,
        ram_used_mb: 0,
        ram_total_mb: 0,
        ram_percent: 0,
        disk_percent: 0,
        uptime: '--',
        platform: '--',
        python_version: '--'
      },
      gcode: {
        state: 'IDLE',
        current_line: 0,
        total_lines: 0,
        progress_percent: 0.0,
        current_command: '',
        distance_mode: 'G90',
        feedrate: 1800.0,
        speed_mm_s: 30.0,
        unit: 'mm',
        elapsed_seconds: 0.0,
        last_error: '',
        recent_logs: []
      }
    });

    // 運動控制參數
    const jogDistance = ref(10.0); // 預設寸動 10mm
    const jogSpeed = ref(30.0);    // 預設寸動速度 30 mm/s
    const customTargetX = ref(0.0);
    const customTargetZ = ref(0.0);

    // G-Code 自動化控制參數
    const quickGcodeCmd = ref('');
    const gcodeMdiInput = ref('');
    const selectedTemplate = ref('');
    const gcodeLogs = ref([]);
    const gcodeScript = ref(`; 雙軸龍門自動化示範程式 (Pick & Place)
G90          ; 絕對座標模式
M17          ; 鎖定全軸馬達
G28          ; 全軸自動歸零 (Z先升後X)
G1 Z80 F1800 ; 提升至安全高度 80mm
G1 X150 F2400; 移動至工位 A (X=150mm)
G1 Z25 F1200 ; 下降至拾取點
M3 P1        ; 開啟電磁鐵 EM1 吸附
G4 P1.0      ; 延時 1 秒確保吸附牢固
G1 Z100 F1500; 垂直提起工件
G1 X350 F2400; 平移至目標工位 B (X=350mm)
G1 Z30 F1200 ; 下降至放置點
M5 P1        ; 釋放電磁鐵 EM1 斷電脫附
G4 P0.5      ; 延時 0.5 秒釋放
G1 Z100 F1800; 提升至安全高度
G1 X0 F2400  ; 返回原點待機
M30          ; 程式正常結束
`);

    const gcodeTemplates = {
      homing: `; 範例 1: 全軸原點歸零與校準
M17          ; 致能鎖定全軸馬達
G90          ; 絕對座標模式
G28          ; 執行全軸自動原點復歸 (Z先升至頂部，後X向左碰原點)
G1 Z50 F1200 ; 下降至安全待機高度
M114         ; 查詢並輸出當前精確座標
`,
      pick_place: `; 範例 2: 工件吸附搬運示範 (Pick & Place)
G90          ; 絕對座標模式
M17          ; 鎖定全軸馬達
G1 Z120 F1800; 提升至巡航安全高度 (120mm)
G1 X120 F2400; 水平快速移動至工位 A 上方
G1 Z25 F1200 ; 下降至工件表面
M3 P1        ; 開啟電磁鐵 EM1 強力吸附
G4 P1.0      ; 等待 1 秒確保吸附牢固
G1 Z150 F1500; 垂直平穩提起工件
G1 X380 F2400; 水平橫移至目標放置工位 B
G1 Z30 F1200 ; 下降至放置目標高度
M5 P1        ; 釋放電磁鐵 EM1 斷電脫附
G4 P0.5      ; 等待工件穩定脫落
G1 Z150 F1800; 提升至安全高度
G1 X0 F2400  ; 返回原點待機
M30          ; 程式正常結束
`,
      motion_test: `; 範例 3: 兩軸往返循跡耐久檢測
G90          ; 絕對座標模式
G1 X50 Z40 F1800
G1 X250 Z40 F2400
G1 X250 Z120 F1500
G1 X50 Z120 F2400
G1 X50 Z40 F1800
M114         ; 查詢座標校對
M30
`,
      matrix_scan: `; 範例 4: 8 點感測工位掃描檢測
G90
G1 Z100 F1800
G1 X50 F2400
M119         ; 讀取當前感測器
G1 X150 F2400
M119
G1 X250 F2400
M119
G1 X350 F2400
M119
G1 X0 Z100 F2400
M30
`
    };

    // 系統日誌
    const logs = ref([]);
    const addLog = (msg, type = 'info') => {
      const timeStr = new Date().toLocaleTimeString();
      logs.value.unshift({ time: timeStr, text: msg, type });
      if (logs.value.length > 50) logs.value.pop();
    };

    // WebSocket 連線
    let ws = null;
    const wsConnected = ref(false);

    const initWebSocket = () => {
      const loc = window.location;
      const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProto}//${loc.host}/ws/telemetry`;

      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsConnected.value = true;
        addLog('即時遙測 WebSocket 連線建立成功', 'info');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          Object.assign(telemetry, data);
        } catch (e) {
          console.error('解析遙測失敗', e);
        }
      };

      ws.onclose = () => {
        wsConnected.value = false;
        setTimeout(initWebSocket, 2000); // 斷線自動重試
      };

      ws.onerror = (err) => {
        console.error('WS 發生錯誤', err);
      };
    };

    // --- API 呼叫 ---
    const sendJog = async (axis, dir) => {
      const dist = Math.max(0.01, parseFloat(jogDistance.value) || 1.0);
      const speed = Math.max(1.0, parseFloat(jogSpeed.value) || 20.0);
      try {
        const res = await fetch('/api/jog', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            axis,
            direction: dir,
            distance: dist,
            speed
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '寸動失敗');
        addLog(`觸發 ${axis} 軸寸動: ${dir > 0 ? '+' : '-'}${dist}mm (${speed}mm/s)`, 'info');
      } catch (err) {
        addLog(`寸動失敗: ${err.message}`, 'err');
      }
    };

    const moveToCustom = async () => {
      try {
        const x = parseFloat(customTargetX.value);
        const z = parseFloat(customTargetZ.value);
        const speed = Math.max(1.0, parseFloat(jogSpeed.value) || 20.0);
        const res = await fetch('/api/move_to', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x, z, speed })
        });
        if (!res.ok) throw new Error('定位指令拒絕');
        addLog(`目標定位開始: X=${x}mm, Z=${z}mm (指定速度=${speed}mm/s)`, 'info');
      } catch (err) {
        addLog(`定位錯誤: ${err.message}`, 'err');
      }
    };

    // 自動歸零
    const triggerHoming = async (axes = 'ALL') => {
      const axisName = axes === 'ALL' ? '全軸 (Z先升後X)' : `${axes}軸`;
      if (!confirm(`確定要啟動 ${axisName} 自動歸零程序嗎？\n請確認工作區無異物阻擋。`)) return;
      try {
        const res = await fetch('/api/homing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ axes })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '歸零啟動失敗');
        addLog(`已啟動 ${axisName} 自動復歸原點程序`, 'info');
      } catch (err) {
        addLog(`歸零失敗: ${err.message}`, 'err');
      }
    };

    // 馬達致能鎖定
    const toggleMotorLock = async (axis) => {
      let currentLocked = true;
      if (axis === 'X') currentLocked = telemetry.motor_x.is_locked;
      else if (axis === 'Z') currentLocked = telemetry.motor_z.is_locked;
      else currentLocked = telemetry.motor_x.is_locked && telemetry.motor_z.is_locked;

      const targetLock = !currentLocked;
      const actionName = targetLock ? '鎖定 (保持力矩)' : '釋放 (手動移動)';

      try {
        const res = await fetch('/api/motor/lock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ axis, locked: targetLock })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);
        addLog(`${axis} 軸馬達致能已切換為: ${actionName}`, 'info');
      } catch (err) {
        addLog(`馬達致能設定失敗: ${err.message}`, 'err');
      }
    };

    // 電磁鐵控制
    const toggleElectromagnet = async (channel) => {
      const current = telemetry.electromagnets[`em${channel}`];
      const targetState = !current;
      try {
        const res = await fetch('/api/electromagnet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, state: targetState })
        });
        if (!res.ok) throw new Error('控制失敗');
        addLog(`電磁鐵 EM${channel} -> ${targetState ? '吸附' : '關閉'}`, 'info');
      } catch (err) {
        addLog(`電磁鐵控制失敗: ${err.message}`, 'err');
      }
    };

    const toggleAllElectromagnets = async (state) => {
      try {
        const res = await fetch('/api/electromagnet/all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state })
        });
        if (!res.ok) throw new Error('控制失敗');
        addLog(`全部電磁鐵 -> ${state ? '全部吸附' : '全部斷電'}`, 'info');
      } catch (err) {
        addLog(`電磁鐵整體控制失敗: ${err.message}`, 'err');
      }
    };

    // 緊急停止
    const triggerEStop = async () => {
      try {
        await fetch('/api/estop', { method: 'POST' });
        addLog('【緊急煞車】已立即中斷所有軸向運轉！', 'err');
      } catch (err) {
        console.error(err);
      }
    };

    const clearEStop = async () => {
      try {
        await fetch('/api/estop/clear', { method: 'POST' });
        addLog('緊急停止已重置復歸，系統回到待機態', 'info');
      } catch (err) {
        console.error(err);
      }
    };

    // 模擬模式手動觸發感測器測試
    const toggleSimSensor = async (sensorName) => {
      if (!telemetry.is_simulation) return;
      const current = telemetry.sensors[sensorName];
      try {
        await fetch('/api/sim/sensor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sensor_name: sensorName, active: !current })
        });
        addLog(`[模擬] 手動切換感測器 ${sensorName} -> ${!current ? '觸發' : '復歸'}`, 'info');
      } catch (e) {
        console.error(e);
      }
    };

    // --- 馬達參數設定管理 ---
    const configForm = ref(null);
    const loadConfig = async () => {
      try {
        const res = await fetch('/api/config');
        configForm.value = await res.json();
      } catch (err) {
        addLog(`讀取設定檔失敗: ${err.message}`, 'err');
      }
    };

    const saveConfig = async () => {
      if (!confirm('確認儲存並立即套用新的馬達與系統設定？')) return;
      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(configForm.value)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail);
        addLog('馬達設定已成功儲存並動態更新！', 'info');
      } catch (err) {
        addLog(`儲存設定失敗: ${err.message}`, 'err');
      }
    };

    // --- 系統更新維護 ---
    const isUpdating = ref(false);
    const updateResult = ref('');

    const runGitUpdate = async () => {
      if (!confirm('即將執行 git pull 線上檢查並拉取最新程式碼？')) return;
      isUpdating.value = true;
      updateResult.value = '正在拉取更新...';
      try {
        const res = await fetch('/api/system/update', { method: 'POST' });
        const data = await res.json();
        updateResult.value = data.message || (data.success ? '更新完畢' : '更新失敗');
        addLog(`系統更新執行: ${updateResult.value}`, data.success ? 'info' : 'warn');
      } catch (err) {
        updateResult.value = `更新失敗: ${err.message}`;
        addLog(updateResult.value, 'err');
      } finally {
        isUpdating.value = false;
      }
    };

    const runServiceRestart = async () => {
      if (!confirm('確定重啟後端服務 (gantry-control.service) 嗎？\n連線將暫時中斷 3 秒。')) return;
      try {
        const res = await fetch('/api/system/restart', { method: 'POST' });
        const data = await res.json();
        addLog(data.message, 'info');
      } catch (err) {
        addLog(`服務重啟請求失敗: ${err.message}`, 'err');
      }
    };

    const runReboot = async () => {
      if (!confirm('警告：確定要重新啟動樹梅派主機嗎？')) return;
      try {
        const res = await fetch('/api/system/reboot', { method: 'POST' });
        const data = await res.json();
        addLog(data.message, 'warn');
      } catch (err) {
        addLog(`重開機失敗: ${err.message}`, 'err');
      }
    };

    const runShutdown = async () => {
      if (!confirm('🛑 警告：確定要將樹梅派主機安全關機嗎？\n關機後若需重新啟動，需手動重新插拔電源！')) return;
      try {
        const res = await fetch('/api/system/shutdown', { method: 'POST' });
        const data = await res.json();
        addLog(data.message, 'err');
        alert('樹梅派主機關機指令已下達，系統正在安全關閉電源...');
      } catch (err) {
        addLog(`關機請求失敗: ${err.message}`, 'err');
      }
    };

    // --- 電磁鐵開機硬體防跳動保護 ---
    const bootClampStatus = ref({ is_fixed: false, message: '', loading: false });
    const bootClampResult = ref('');

    const fetchBootClampStatus = async () => {
      try {
        const res = await fetch('/api/system/boot_electromagnets_status');
        const data = await res.json();
        bootClampStatus.value.is_fixed = !!data.is_fixed;
        bootClampStatus.value.message = data.message || '';
      } catch (err) {
        console.error('查詢開機電磁鐵配置狀態失敗:', err);
      }
    };

    const runFixBootElectromagnets = async () => {
      if (!confirm('即將自動修改樹梅派 config.txt 與系統開機設定：\n1. 將 GPIO 2, 4, 14, 15 設定為 Bootloader 早期推挽低電位鎖定 (op, dl)\n2. 關閉 UART 序列控制台 (enable_uart=0)\n\n確定立即套用修復嗎？')) return;
      bootClampStatus.value.loading = true;
      bootClampResult.value = '正在執行開機鎖定修復腳本...';
      try {
        const res = await fetch('/api/system/fix_boot_electromagnets', { method: 'POST' });
        const data = await res.json();
        bootClampResult.value = data.message || (data.success ? '修復設定套用成功！' : '修復失敗');
        addLog(`電磁鐵開機硬體鎖定修復: ${data.success ? '成功' : '失敗'}`, data.success ? 'info' : 'err');
        await fetchBootClampStatus();
      } catch (err) {
        bootClampResult.value = `執行修復失敗: ${err.message}`;
        addLog(bootClampResult.value, 'err');
      } finally {
        bootClampStatus.value.loading = false;
      }
    };

    // 計算 X 軸和 Z 軸的行程進度百分比 (用於條狀指示)
    const xProgressPercent = computed(() => {
      const min = telemetry.motor_x.min_limit_mm;
      const max = telemetry.motor_x.max_limit_mm;
      const cur = telemetry.motor_x.position_mm;
      if (max <= min) return 0;
      return Math.min(100, Math.max(0, ((cur - min) / (max - min)) * 100));
    });

    const zProgressPercent = computed(() => {
      const min = telemetry.motor_z.min_limit_mm;
      const max = telemetry.motor_z.max_limit_mm;
      const cur = telemetry.motor_z.position_mm;
      if (max <= min) return 0;
      return Math.min(100, Math.max(0, ((cur - min) / (max - min)) * 100));
    });

    // --- G-Code 自動化控制 ---
    const addGCodeLog = (text, status = 'ok') => {
      const time = new Date().toLocaleTimeString();
      gcodeLogs.value.unshift({ time, text, status });
      if (gcodeLogs.value.length > 80) gcodeLogs.value.pop();
    };

    const getGCodeStateStyle = () => {
      const st = telemetry.gcode ? telemetry.gcode.state : 'IDLE';
      if (st === 'RUNNING') return { background: '#059669', color: '#fff', border: '1px solid #10b981' };
      if (st === 'PAUSED') return { background: '#d97706', color: '#fff', border: '1px solid #f59e0b' };
      if (st === 'COMPLETED') return { background: '#0284c7', color: '#fff', border: '1px solid #38bdf8' };
      if (st === 'ERROR') return { background: '#dc2626', color: '#fff', border: '1px solid #ef4444' };
      return { background: '#334155', color: '#94a3b8', border: '1px solid #475569' };
    };

    const executeGCodeLine = async (command) => {
      if (!command || !command.trim()) return;
      try {
        const res = await fetch('/api/gcode/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: command.trim() })
        });
        const data = await res.json();
        addGCodeLog(`${command} ➔ ${data.message || 'OK'}`, data.status || 'ok');
        addLog(`G-Code: ${command} (${data.message || 'OK'})`, data.status === 'error' ? 'err' : 'info');
      } catch (err) {
        addGCodeLog(`${command} ➔ 錯誤: ${err.message}`, 'error');
        addLog(`G-Code 指令執行失敗: ${err.message}`, 'err');
      }
    };

    const sendQuickGcode = () => {
      if (!quickGcodeCmd.value) return;
      executeGCodeLine(quickGcodeCmd.value);
      quickGcodeCmd.value = '';
    };

    const sendMdiGCode = () => {
      if (!gcodeMdiInput.value) return;
      executeGCodeLine(gcodeMdiInput.value);
      gcodeMdiInput.value = '';
    };

    const sendQuickSnippet = (snippet) => {
      executeGCodeLine(snippet);
    };

    const startGCodeProgram = async () => {
      if (!gcodeScript.value.trim()) {
        alert('請先輸入或載入 G-Code 腳本內容！');
        return;
      }
      try {
        const res = await fetch('/api/gcode/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gcode: gcodeScript.value })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || '啟動失敗');
        addGCodeLog('▶️ G-Code 程式已啟動自動化執行', 'ok');
        addLog('G-Code 自動化排程開始執行', 'info');
      } catch (err) {
        alert('無法啟動 G-Code 程式: ' + err.message);
        addGCodeLog(`啟動失敗: ${err.message}`, 'error');
      }
    };

    const pauseGCodeProgram = async () => {
      try {
        await fetch('/api/gcode/pause', { method: 'POST' });
        addGCodeLog('⏸️ G-Code 程式已手動暫停', 'ok');
        addLog('G-Code 程式已暫停', 'info');
      } catch (err) {
        console.error(err);
      }
    };

    const resumeGCodeProgram = async () => {
      try {
        await fetch('/api/gcode/resume', { method: 'POST' });
        addGCodeLog('⏯️ G-Code 程式已恢復執行', 'ok');
        addLog('G-Code 程式恢復執行', 'info');
      } catch (err) {
        console.error(err);
      }
    };

    const stopGCodeProgram = async () => {
      if (!confirm('確定要強制中斷並停止目前 G-Code 腳本執行嗎？')) return;
      try {
        await fetch('/api/gcode/stop', { method: 'POST' });
        addGCodeLog('⏹️ G-Code 程式已被使用者強制中止', 'error');
        addLog('G-Code 程式已中止', 'err');
      } catch (err) {
        console.error(err);
      }
    };

    const loadGCodeFile = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (event) => {
        gcodeScript.value = event.target.result;
        addGCodeLog(`已從檔案載入: ${file.name} (${file.size} bytes)`, 'ok');
        addLog(`成功載入 G-Code 檔案: ${file.name}`, 'info');
      };
      reader.readAsText(file);
    };

    const downloadGCodeFile = () => {
      const blob = new Blob([gcodeScript.value], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'nice_gcode_' + new Date().toISOString().slice(0, 10) + '.gcode';
      a.click();
      URL.revokeObjectURL(url);
    };

    const applyGCodeTemplate = () => {
      const t = selectedTemplate.value;
      if (!t || !gcodeTemplates[t]) return;
      gcodeScript.value = gcodeTemplates[t];
      addGCodeLog(`已載入預設範本: ${selectedTemplate.value}`, 'ok');
    };

    onMounted(() => {
      initWebSocket();
      loadConfig();
      fetchBootClampStatus();
      addLog('控制系統前端初始化就緒', 'info');
    });

    onUnmounted(() => {
      if (ws) ws.close();
    });

    return {
      currentTab,
      telemetry,
      wsConnected,
      jogDistance,
      jogSpeed,
      customTargetX,
      customTargetZ,
      quickGcodeCmd,
      gcodeMdiInput,
      selectedTemplate,
      gcodeLogs,
      gcodeScript,
      getGCodeStateStyle,
      sendQuickGcode,
      sendMdiGCode,
      sendQuickSnippet,
      startGCodeProgram,
      pauseGCodeProgram,
      resumeGCodeProgram,
      stopGCodeProgram,
      loadGCodeFile,
      downloadGCodeFile,
      applyGCodeTemplate,
      logs,
      configForm,
      isUpdating,
      updateResult,
      bootClampStatus,
      bootClampResult,
      fetchBootClampStatus,
      runFixBootElectromagnets,
      xProgressPercent,
      zProgressPercent,
      sendJog,
      moveToCustom,
      triggerHoming,
      toggleMotorLock,
      toggleElectromagnet,
      toggleAllElectromagnets,
      triggerEStop,
      clearEStop,
      toggleSimSensor,
      saveConfig,
      runGitUpdate,
      runServiceRestart,
      runReboot,
      runShutdown
    };
  }
}).mount('#app');

