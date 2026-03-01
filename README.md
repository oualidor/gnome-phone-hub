# Phone HUB 📱

Phone HUB is a GNOME Shell Extension that integrates your Android device directly into your Quick Settings menu. It allows you to monitor your phone's battery life and transform your device into a high-quality (1080p 60fps) Linux webcam with a single toggle.



## ✨ Features
* **Live Battery Monitoring:** See your phone's charge percentage directly in the GNOME menu.
* **Pro Webcam Toggle:** One-click activation of your phone as a virtual camera (`/dev/video42`).
* **Background Processing:** Uses `scrcpy` and `v4l2loopback` to stream video with ultra-low latency.
* **Smart Scanning:** Automatically detects connected devices via ADB.

---

## 🛠 Prerequisites

Before installing the extension, you must set up your environment:

### 1. System Packages
Install the core dependencies on your Debian/Ubuntu system:
```bash
sudo apt update
sudo apt install adb scrcpy v4l2loopback-dkms v4l2loopback-utils

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
Enable Developer Options: Go to Settings > About Phone and tap Build Number 7 times.

Enable USB Debugging: Found inside Developer Options.

Trust Connection: Connect via USB and select "Always allow from this computer" when prompted.


Author: Oualid Khial