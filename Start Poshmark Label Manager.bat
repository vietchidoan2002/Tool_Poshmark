@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Poshmark Label Manager
where node >nul 2>nul
if errorlevel 1 (
 echo Chua cai Node.js. Hay cai Node.js LTS tu https://nodejs.org/ roi chay lai.
 pause
 exit /b 1
)
if not exist config.json copy config.example.json config.json >nul
if not exist node_modules (
 echo Dang cai thu vien lan dau, can Internet...
 call npm install
 if errorlevel 1 (echo Cai thu vien that bai.& pause & exit /b 1)
)
if not exist credentials.json echo CAN THEM credentials.json vao thu muc goc truoc khi ket noi Gmail.
start "" http://127.0.0.1:5173
call npm run dev
pause
