<#
.SYNOPSIS
  YouTube 98 — server-side installer for Windows 10/11.

.DESCRIPTION
  Checks or installs Node.js, Python, ffmpeg and yt-dlp, creates the output
  directory, and optionally registers scheduled tasks, an SMB share and a
  firewall rule.

  The Win98 box is still the client. This only sets up the machine that
  does the downloading and transcoding.

.EXAMPLE
  .\install.ps1
  Check dependencies and create directories.

.EXAMPLE
  .\install.ps1 -InstallDeps -Tasks
  Install anything missing via winget, then register scheduled tasks so
  the server and worker start at logon.

.EXAMPLE
  .\install.ps1 -Share -Firewall
  Also share the output folder over SMB and open the port. Needs an
  elevated prompt.

.NOTES
  -Share and -Firewall require Administrator. Everything else does not.
#>

[CmdletBinding()]
param(
  [string] $OutDir   = (Join-Path $env:USERPROFILE 'youtube98'),
  [string] $WinPath  = '',
  [int]    $Port     = 8098,
  [string] $Cookies  = (Join-Path $env:USERPROFILE 'cookies.txt'),
  [string] $ShareName = 'youtube98',
  [switch] $InstallDeps,
  [switch] $Tasks,
  [switch] $Share,
  [switch] $Firewall
)

$ErrorActionPreference = 'Stop'
$Base = $PSScriptRoot

function Say   { param($m) Write-Host "  $m" }
function Head  { param($m) Write-Host "`n== $m" -ForegroundColor Cyan }
function Warn  { param($m) Write-Host "  WARNING: $m" -ForegroundColor Yellow }
function Fail  { param($m) Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Find-Exe {
  param([string[]] $Names)
  foreach ($n in $Names) {
    $c = Get-Command $n -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
  }
  return $null
}

function Winget-Install {
  param([string] $Id, [string] $Label)
  if (-not (Find-Exe @('winget'))) { Fail "winget not available; install $Label manually." }
  Say "installing $Label via winget ($Id)"
  & winget install --id $Id --accept-source-agreements --accept-package-agreements -h
  # winget does not refresh this process's PATH.
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path','User')
}

# On Windows the server usually holds the files itself, so the retro box
# maps a share of $OutDir. Default the "as Win98 sees it" path to the
# local one; override with -WinPath once the share is mapped to a letter.
if (-not $WinPath) { $WinPath = $OutDir.TrimEnd('\') + '\' }

# --- dependencies ---------------------------------------------------------

Head 'Checking dependencies'

$node = Find-Exe @('node')
if (-not $node -and $InstallDeps) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'; $node = Find-Exe @('node') }
if (-not $node) { Fail 'node not found. Re-run with -InstallDeps, or install Node.js LTS.' }
Say "node    $(& $node --version)  ($node)"

$python = Find-Exe @('python','python3','py')
if (-not $python -and $InstallDeps) { Winget-Install 'Python.Python.3.12' 'Python 3'; $python = Find-Exe @('python','python3','py') }
if (-not $python) { Fail 'python not found. Re-run with -InstallDeps, or install Python 3.' }
Say "python  $(& $python --version 2>&1)  ($python)"

$ffmpeg = Find-Exe @('ffmpeg')
if (-not $ffmpeg -and $InstallDeps) { Winget-Install 'Gyan.FFmpeg' 'ffmpeg'; $ffmpeg = Find-Exe @('ffmpeg') }
if (-not $ffmpeg) { Fail 'ffmpeg not found. Re-run with -InstallDeps, or install ffmpeg and put it on PATH.' }
Say "ffmpeg  ($ffmpeg)"

$ytdlp = Find-Exe @('yt-dlp','yt-dlp.exe')
if (-not $ytdlp) {
  # Prefer the standalone release binary: it self-updates and never goes
  # stale the way a repackaged one can.
  $dest = Join-Path $env:LOCALAPPDATA 'Programs\yt-dlp'
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  $exe = Join-Path $dest 'yt-dlp.exe'
  Say "downloading yt-dlp.exe to $exe"
  Invoke-WebRequest -UseBasicParsing `
    -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' `
    -OutFile $exe
  # Put it on the user's PATH for future sessions, and this one.
  $userPath = [Environment]::GetEnvironmentVariable('Path','User')
  if ($userPath -notlike "*$dest*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
    Say "added $dest to your user PATH (new terminals will see it)"
  }
  $env:Path += ";$dest"
  $ytdlp = $exe
}
Say "yt-dlp  $(& $ytdlp --version)  ($ytdlp)"

# --- directories ----------------------------------------------------------

Head 'Directories'
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir '.tmp') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Base 'cache\jobs') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Base 'thumbs') | Out-Null
Say "output  $OutDir"
Say "cache   $(Join-Path $Base 'cache')"

# --- cookies --------------------------------------------------------------

Head 'Cookies'
if (Test-Path $Cookies) {
  Say "found $Cookies"
  $first = Get-Content $Cookies -TotalCount 1
  if ($first -notmatch 'Netscape') { Warn 'does not look like a Netscape cookies.txt' }
  # NTFS has no chmod; restrict the ACL to the current user instead.
  try {
    $acl = Get-Acl $Cookies
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
      "$env:USERDOMAIN\$env:USERNAME", 'FullControl', 'Allow')))
    Set-Acl -Path $Cookies -AclObject $acl
    Say 'ACL restricted to your account only'
  } catch { Warn "could not tighten the ACL: $($_.Exception.Message)" }
} else {
  Say "no cookie jar at $Cookies"
  Say 'The personalised feed needs one. Export a Netscape cookies.txt and'
  Say 'keep it OUTSIDE this folder and outside the share. Public mode'
  Say 'works without it.'
}
if ($Cookies.StartsWith($OutDir, 'OrdinalIgnoreCase')) {
  Warn 'the cookie jar is inside the shared output folder. Move it out.'
}

# --- SMB share ------------------------------------------------------------

if ($Share) {
  Head 'SMB share'
  if (-not (Test-Admin)) { Fail '-Share needs an elevated prompt.' }
  if (Get-SmbShare -Name $ShareName -ErrorAction SilentlyContinue) {
    Say "share '$ShareName' already exists"
  } else {
    New-SmbShare -Name $ShareName -Path $OutDir -FullAccess "$env:USERNAME" | Out-Null
    Say "created share \\$env:COMPUTERNAME\$ShareName -> $OutDir"
  }
  Warn 'Windows 98 needs SMB1 to connect, which modern Windows disables by'
  Warn 'default and which is insecure. Enabling it is a deliberate choice:'
  Warn '  Optional Features -> SMB 1.0/CIFS Client/Server'
  Warn 'Consider instead copying files to the retro box another way, or'
  Warn 'running the server on a Linux box with Samba configured for SMB1.'
}

# --- firewall -------------------------------------------------------------

if ($Firewall) {
  Head 'Firewall'
  if (-not (Test-Admin)) { Fail '-Firewall needs an elevated prompt.' }
  $rule = "YouTube 98 ($Port)"
  if (Get-NetFirewallRule -DisplayName $rule -ErrorAction SilentlyContinue) {
    Say 'rule already exists'
  } else {
    New-NetFirewallRule -DisplayName $rule -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
    Say "allowed inbound TCP $Port on the Private profile"
  }
}

# --- scheduled tasks ------------------------------------------------------

if ($Tasks) {
  Head 'Scheduled tasks'

  # Env vars are passed via a generated cmd wrapper: scheduled tasks have
  # no shell profile, so nothing is inherited.
  $wrapper = Join-Path $Base 'run-youtube98.cmd'
  @"
@echo off
rem Generated by install.ps1 — edit here to change configuration.
set YT98_OUT=$OutDir
set YT98_WIN_PATH=$WinPath
set YT98_PORT=$Port
set YT98_COOKIES=$Cookies
set YT98_YTDLP=$ytdlp
set YT98_PYTHON=$python
cd /d "$Base"
if "%1"=="server" "$node" "$Base\server.js"
if "%1"=="worker" "$node" "$Base\worker.js"
if "%1"=="feed"   "$python" "$Base\refresh-feed.py"
"@ | Set-Content -Path $wrapper -Encoding ASCII
  Say "wrote $wrapper"

  function Set-Task {
    param($Name, $Arg, $Trigger)
    $action = New-ScheduledTaskAction -Execute $wrapper -Argument $Arg -WorkingDirectory $Base
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 `
      -RestartInterval (New-TimeSpan -Minutes 1)
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Trigger `
      -Settings $set -Description 'YouTube 98' | Out-Null
    Say "registered $Name"
  }

  $atLogon = New-ScheduledTaskTrigger -AtLogOn
  Set-Task 'YouTube98 Server' 'server' $atLogon
  Set-Task 'YouTube98 Worker' 'worker' $atLogon

  $every30 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 30)
  Set-Task 'YouTube98 Feed Refresh' 'feed' $every30

  Say 'starting the server and worker now'
  Start-ScheduledTask -TaskName 'YouTube98 Server'
  Start-ScheduledTask -TaskName 'YouTube98 Worker'
}

# --- done -----------------------------------------------------------------

Head 'Done'
if (-not $Tasks) {
  Say 'Build the feed:   python refresh-feed.py'
  Say 'Start the server: node server.js'
  Say 'Start the worker: node worker.js'
  Say 'Re-run with -Tasks to register scheduled tasks instead.'
}
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
       Select-Object -First 1).IPAddress
Say "Open http://${ip}:$Port/ from the retro box."
Say ''
Say "Share $OutDir so the Win98 box can read it, then re-run with"
Say '-WinPath set to the mapped path (e.g. Z:\) so Play and copy-path work.'
Say 'Install setup\play.vbs + setup\youtube98.reg on the Win98 machine.'
