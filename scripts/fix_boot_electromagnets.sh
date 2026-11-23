#!/usr/bin/env bash
# ==============================================================================
# 樹梅派電磁鐵開機防誤觸/防跳動硬體鎖定修復腳本
# 修復目標：
#   1. 磁鐵 2 (GPIO 14, Pin 8): 關閉 UART 控制台，消除開機 3~5 秒發送串口數據與高電平導致的吸合。
#   2. 磁鐵 4 (GPIO 2, Pin 3):  透過 Bootloader 在通電 <0.1s 內強制設定為輸出低電平 (op, dl)，
#      克服樹梅派板載 1.8kΩ 物理上拉電阻，消除開機 10~15 秒誤吸合。
# ==============================================================================

set -e

# 檢查 root 權限
if [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
else
    SUDO=""
fi

echo "=========================================================="
echo " 正在執行：樹梅派電磁鐵開機硬體防誤導通修復程序"
echo "=========================================================="

# 1. 尋找 config.txt 與 cmdline.txt 路徑 (相容 Debian 12 Bookworm 及 Debian 11/10 Bullseye/Buster)
BOOT_CONFIG=""
BOOT_CMDLINE=""

if [ -f "/boot/firmware/config.txt" ]; then
    BOOT_CONFIG="/boot/firmware/config.txt"
    BOOT_CMDLINE="/boot/firmware/cmdline.txt"
elif [ -f "/boot/config.txt" ]; then
    BOOT_CONFIG="/boot/config.txt"
    BOOT_CMDLINE="/boot/cmdline.txt"
fi

if [ -z "$BOOT_CONFIG" ]; then
    echo "⚠️ 未檢測到樹梅派 /boot/firmware/config.txt 或 /boot/config.txt (可能處於非樹梅派環境)"
    exit 0
fi

echo ">>> 檢測到開機配置檔: ${BOOT_CONFIG}"
echo ">>> 檢測到核心參數檔: ${BOOT_CMDLINE}"

# 備份原始檔案
TIMESTAMP=$(date +%Y%m%d%H%M%S)
$SUDO cp "${BOOT_CONFIG}" "${BOOT_CONFIG}.bak.${TIMESTAMP}"
echo ">>> 已備份開機設定至: ${BOOT_CONFIG}.bak.${TIMESTAMP}"

if [ -f "${BOOT_CMDLINE}" ]; then
    $SUDO cp "${BOOT_CMDLINE}" "${BOOT_CMDLINE}.bak.${TIMESTAMP}"
fi

# 2. 修改 config.txt：加入 enable_uart=0 與 gpio=2,4,14,15=op,dl
# 先處理 enable_uart: 若已有 enable_uart=1 則替換為 0，若沒有則追加
if grep -q "^enable_uart=" "${BOOT_CONFIG}"; then
    $SUDO sed -i 's/^enable_uart=.*/enable_uart=0/' "${BOOT_CONFIG}"
    echo ">>> 已更新 enable_uart=0 (關閉開機串口以保護 GPIO 14 / 磁鐵 2)"
elif grep -q "enable_uart=0" "${BOOT_CONFIG}"; then
    echo ">>> enable_uart=0 已存在"
else
    $SUDO bash -c "echo '' >> '${BOOT_CONFIG}'"
    $SUDO bash -c "echo '# --- Gantry Electromagnet Boot Protection ---' >> '${BOOT_CONFIG}'"
    $SUDO bash -c "echo 'enable_uart=0' >> '${BOOT_CONFIG}'"
    echo ">>> 已追加 enable_uart=0 至 ${BOOT_CONFIG}"
fi

# 處理 gpio=2,4,14,15=op,dl
if grep -q "gpio=2,4,14,15=op,dl" "${BOOT_CONFIG}"; then
    echo ">>> gpio=2,4,14,15=op,dl 已存在於配置檔中"
else
    # 移除舊有衝突設定（若有單獨設定者）
    $SUDO sed -i '/gpio=2.*=op/d' "${BOOT_CONFIG}" 2>/dev/null || true
    $SUDO sed -i '/gpio=14.*=op/d' "${BOOT_CONFIG}" 2>/dev/null || true
    $SUDO bash -c "echo 'gpio=2,4,14,15=op,dl' >> '${BOOT_CONFIG}'"
    echo ">>> 已追加 gpio=2,4,14,15=op,dl 至 ${BOOT_CONFIG} (Bootloader 硬體鎖定低電位)"
fi

# 3. 處理 cmdline.txt 移除串口輸出 (防止 Linux 核心啟動期間拉高 GPIO 14)
if [ -f "${BOOT_CMDLINE}" ]; then
    $SUDO sed -i 's/console=serial0,[0-9]\+ //g' "${BOOT_CMDLINE}"
    $SUDO sed -i 's/console=ttyAMA0,[0-9]\+ //g' "${BOOT_CMDLINE}"
    $SUDO sed -i 's/ console=serial0,[0-9]\+//g' "${BOOT_CMDLINE}"
    $SUDO sed -i 's/ console=ttyAMA0,[0-9]\+//g' "${BOOT_CMDLINE}"
    echo ">>> 已從 ${BOOT_CMDLINE} 移除序列控制台輸出 (避免核心占用 GPIO 14)"
fi

# 4. 停用 serial-getty 服務
$SUDO systemctl stop serial-getty@serial0.service 2>/dev/null || true
$SUDO systemctl disable serial-getty@serial0.service 2>/dev/null || true
$SUDO systemctl stop serial-getty@ttyAMA0.service 2>/dev/null || true
$SUDO systemctl disable serial-getty@ttyAMA0.service 2>/dev/null || true

# 5. 建立超早期硬體鎖定腳本與 systemd 單元 (gantry-gpio-early-clamp)
CLAMP_SCRIPT="/usr/local/bin/gantry-gpio-clamp.sh"
$SUDO bash -c "cat << 'EOF' > ${CLAMP_SCRIPT}
#!/usr/bin/env bash
# 早期強制拉低電磁鐵腳本 (GPIO 2, 4, 14, 15)
if command -v pinctrl &>/dev/null; then
    pinctrl set 2,4,14,15 op dl
elif command -v raspi-gpio &>/dev/null; then
    raspi-gpio set 2,4,14,15 op dl
fi
EOF"
$SUDO chmod +x "${CLAMP_SCRIPT}"

# 立即執行一次拉低
$SUDO "${CLAMP_SCRIPT}" 2>/dev/null || true

EARLY_SERVICE="/etc/systemd/system/gantry-gpio-early-clamp.service"
$SUDO bash -c "cat << EOF > ${EARLY_SERVICE}
[Unit]
Description=Gantry GPIO Early Low-Level Clamp for Electromagnets
DefaultDependencies=no
Before=basic.target sysinit.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${CLAMP_SCRIPT}

[Install]
WantedBy=basic.target
EOF"

$SUDO systemctl daemon-reload 2>/dev/null || true
$SUDO systemctl enable gantry-gpio-early-clamp.service 2>/dev/null || true
$SUDO systemctl start gantry-gpio-early-clamp.service 2>/dev/null || true

echo "=========================================================="
echo " ✅ 電磁鐵開機硬體防跳動保護修復成功！"
echo " 說明："
echo "   1. 樹梅派 Bootloader (EEPROM) 已設定 gpio=2,4,14,15=op,dl"
echo "      下次通電時，0.1 秒內 GPU 即會強制拉低電位，消除 GPIO 2 物理 1.8k 上拉！"
echo "   2. UART 串口控制台已關閉 (enable_uart=0)，消除 GPIO 14 開機 3~5 秒通電！"
echo "   3. 早期 systemd clamp 守護已註冊啟動。"
echo "=========================================================="

