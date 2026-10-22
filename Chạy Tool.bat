@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Poshmark Label Manager - Quản lý Poshmark

where node >nul 2>nul
if errorlevel 1 (
    echo Chưa cài đặt Node.js.
    echo Vui lòng cài đặt Node.js bản LTS tại: https://nodejs.org/
    echo Sau đó chạy lại chương trình.
    pause
    exit /b 1
)

if not exist config.json (
    if exist config.example.json (
        copy config.example.json config.json >nul
        echo Đã tạo file cấu hình config.json.
    ) else (
        echo Không tìm thấy config.example.json.
        echo Vui lòng kiểm tra lại thư mục chương trình.
        pause
        exit /b 1
    )
)

if not exist node_modules (
    echo Đang cài đặt các thư viện lần đầu...
    echo Vui lòng chờ và đảm bảo máy tính có kết nối Internet.
    call npm install
    if errorlevel 1 (
        echo Cài đặt thư viện thất bại.
        echo Vui lòng kiểm tra kết nối Internet và thử lại.
        pause
        exit /b 1
    )
)

if not exist credentials.json (
    echo.
    echo LƯU Ý:
    echo Chưa tìm thấy file credentials.json.
    echo Vui lòng thêm file này vào thư mục gốc trước khi kết nối Gmail.
    echo.
)

echo Đang khởi động Poshmark Label Manager...
echo Trình duyệt sẽ mở tại địa chỉ: http://127.0.0.1:5173
echo Hãy giữ cửa sổ này mở trong khi sử dụng chương trình.
echo.

start "" http://127.0.0.1:5173
call npm run dev

echo.
echo Chương trình đã dừng hoặc gặp lỗi.
pause
```