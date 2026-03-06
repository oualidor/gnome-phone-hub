# Phone HUB 📱

Phone HUB is a GNOME Shell Extension that integrates your Android device directly into your Quick Settings menu.



## ✨ Features
* **Live Battery Monitoring:** Mount you phone as a storage device on your Linux system.

* **Calls Notifications:** Respong to your calls from you PC.

* **Notifications:** Get notifications from your phone on your PC.

* **Phone mirroring:** Full control of your phone from your PC.

* **Pro Webcam Toggle:** One-click activation of your phone as a virtual camera


---

## 🛠 Prerequisites

Before installing the extension, you must set up your environment:

### 1. System Packages
Install the core dependencies on your Debian/Ubuntu system:
```bash
sudo apt update
sudo apt install adb scrcpy v4l2loopback-dkms v4l2loopback-utils sshfs sshpass

```
### 2. Define the virtual device options
```bash
echo 'options v4l2loopback video_nr=42 card_label="Phone HUB Camera" exclusive_caps=1' | sudo tee /etc/modprobe.d/phone_hub.conf

# Enable auto-load on boot
echo 'v4l2loopback' | sudo tee /etc/modules-load.d/phone_hub.conf

# Load the module immediately
sudo modprobe v4l2loopback
```

### 3. Android Device Configuration
To use adb and scrcpy, you need to enable USB debugging on your Android device.

1. Enable Developer Options: Go to Settings > About Phone and tap Build Number 7 times.

2. Enable USB Debugging: Found inside Developer Options.

3. Trust Connection: Connect via USB and select "Always allow from this computer" when prompted.


Author: Oualid Khial