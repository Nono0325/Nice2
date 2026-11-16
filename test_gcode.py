import time
from backend.config import config_mgr
from backend.motion_engine import MotionEngine
from backend.gcode_interpreter import GCodeInterpreter, GCodeCommand

def test_gcode_parser():
    cmd = GCodeCommand("G1 X120.5 Z50 F1800 ; Move to pick position", 1)
    assert cmd.cmd == "G1"
    assert cmd.params["X"] == 120.5
    assert cmd.params["Z"] == 50.0
    assert cmd.params["F"] == 1800.0
    assert "Move to pick position" in cmd.comment

    cmd2 = GCodeCommand("M3 P2 (Turn on EM2)", 2)
    assert cmd2.cmd == "M3"
    assert cmd2.params["P"] == 2.0

    cmd3 = GCodeCommand("; Just a comment", 3)
    assert cmd3.is_empty

    cmd4 = GCodeCommand("N10 G28 X Z", 4)
    assert cmd4.cmd == "G28"
    assert "X" in cmd4.params
    assert "Z" in cmd4.params

def test_gcode_execution():
    engine = MotionEngine(config_mgr)
    gcode = GCodeInterpreter(engine)

    # Test M17 (Lock motors)
    res = gcode.execute_line("M17")
    assert res["status"] == "ok"
    assert engine.motor_x.is_locked and engine.motor_z.is_locked

    # Test G92 (Reset origin)
    res = gcode.execute_line("G92 X0 Z0")
    assert res["status"] == "ok"
    assert abs(engine.motor_x.position_mm) < 0.01
    assert abs(engine.motor_z.position_mm) < 0.01

    # Test G90 + G1 movement
    res = gcode.execute_line("G90")
    assert res["status"] == "ok"
    res = gcode.execute_line("G1 X50 Z30 F3000")
    assert res["status"] == "ok"
    assert abs(engine.motor_x.position_mm - 50.0) < 0.5
    assert abs(engine.motor_z.position_mm - 30.0) < 0.5

    # Test G91 (Relative mode)
    res = gcode.execute_line("G91")
    assert res["status"] == "ok"
    res = gcode.execute_line("G1 X10 Z-10 F3000")
    assert res["status"] == "ok"
    assert abs(engine.motor_x.position_mm - 60.0) < 0.5
    assert abs(engine.motor_z.position_mm - 20.0) < 0.5

    # Test M3 / M5 (Electromagnets)
    res = gcode.execute_line("M3 P1")
    assert res["status"] == "ok"
    assert engine.electromagnets.get_states()["em1"] is True

    res = gcode.execute_line("M5 P1")
    assert res["status"] == "ok"
    assert engine.electromagnets.get_states()["em1"] is False

    # Test G4 (Dwell)
    t0 = time.time()
    res = gcode.execute_line("G4 P0.2")
    assert res["status"] == "ok"
    assert time.time() - t0 >= 0.18

    # Test M114 (Query position)
    res = gcode.execute_line("M114")
    assert res["status"] == "ok"
    assert "X:" in res["message"] and "Z:" in res["message"]

    # Test M119 (Query endstops)
    res = gcode.execute_line("M119")
    assert res["status"] == "ok"
    assert "X_Left:" in res["message"]

def test_gcode_program_runner():
    engine = MotionEngine(config_mgr)
    gcode = GCodeInterpreter(engine)

    script = """
    ; Test automated script
    G90
    G92 X0 Z0
    G1 X20 Z10 F3000
    M3 P2
    G4 P0.1
    M5 P2
    G1 X0 Z0 F3000
    M30
    """
    res = gcode.start_program(script)
    assert res["status"] == "ok"
    
    # Wait for completion
    timeout = 10.0
    t0 = time.time()
    while gcode.state == "RUNNING" and time.time() - t0 < timeout:
        time.sleep(0.05)

    assert gcode.state == "COMPLETED"
    assert gcode.total_lines > 0
    status = gcode.get_status()
    assert status["progress_percent"] == 100.0

if __name__ == "__main__":
    test_gcode_parser()
    print("✓ G-Code Parser 測試通過")
    test_gcode_execution()
    print("✓ G-Code 指令即時執行測試通過")
    test_gcode_program_runner()
    print("✓ G-Code 腳本全流程自動化測試通過")
    print("================================")
    print("所有 G-Code 單元測試 100% 通過！")
    print("================================")
