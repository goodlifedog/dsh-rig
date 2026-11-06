# Desktop Agent - Windows 控制后端（UI Automation 桥）
# 用法：
#   powershell -File uia-bridge.ps1 snapshot -Process notepad
#   powershell -File uia-bridge.ps1 click -Index 3
#   powershell -File uia-bridge.ps1 type -Text "hello"
#   powershell -File uia-bridge.ps1 key -Key ENTER
param(
  [Parameter(Position=0)][string]$Command = 'snapshot',
  [string]$Process = '',
  [int]$Index = -1,
  [string]$Text = '',
  [string]$Key = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
"@

$cacheFile = Join-Path $env:TEMP 'desktop-agent-uia.json'

function Get-TargetProcess {
  if (-not $Process) { throw '缺少 -Process 参数' }
  $p = Get-Process -Name $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { throw "找不到进程 $Process" }
  return $p
}

function Get-AppElement($proc) {
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id)
  return [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children, $cond)
}

function Snapshot($proc) {
  $root = Get-AppElement $proc
  if (-not $root) { throw '拿不到应用根元素（可能需要管理员权限）' }
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  $i = 0
  foreach ($el in $all) {
    try {
      $cur = $el.Current
      $r = $cur.BoundingRectangle
      $items += [pscustomobject]@{
        index = $i
        role = $cur.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        name = $cur.Name
        automationId = $cur.AutomationId
        value = ''
        x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
        enabled = $cur.IsEnabled
      }
      $i++
    } catch { continue }
  }
  $payload = [pscustomobject]@{ process = $proc.ProcessName; pid = $proc.Id; elements = $items }
  $payload | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $cacheFile -Encoding UTF8
  Write-Output ($payload | ConvertTo-Json -Depth 5 -Compress)
}

function Load-Cache {
  if (-not (Test-Path $cacheFile)) { throw '没有缓存，请先执行 snapshot' }
  return Get-Content $cacheFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Click-Index($idx) {
  $cache = Load-Cache
  $target = $cache.elements | Where-Object { $_.index -eq $idx } | Select-Object -First 1
  if (-not $target) { throw "索引 $idx 不存在" }
  $proc = Get-Process -Id $cache.pid -ErrorAction SilentlyContinue
  if (-not $proc) { throw '目标进程已退出' }
  $root = Get-AppElement $proc
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
  $i = 0
  foreach ($el in $all) {
    if ($i -eq $idx) {
      $cur = $el.Current
      if ($target.name -and $cur.Name -ne $target.name) {
        throw "索引 $idx 处的元素已变化（缓存=$($target.name) 现在=$($cur.Name)），请重新 snapshot"
      }
      $pattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); Write-Output '{"ok":true,"method":"invoke"}'; return
      }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select(); Write-Output '{"ok":true,"method":"select"}'; return
      }
      # 兜底：把焦点移过去再发回车（不移动鼠标）
      try { $el.SetFocus() } catch { }
      $hwnd = $proc.MainWindowHandle
      [void][Native]::PostMessage($hwnd, 0x0100, [IntPtr]0x0D, [IntPtr]0)
      [void][Native]::PostMessage($hwnd, 0x0101, [IntPtr]0x0D, [IntPtr]0)
      Write-Output '{"ok":true,"method":"focus+enter"}'; return
    }
    $i++
  }
  throw '索引越界，界面可能已变化，请重新 snapshot'
}

function Type-Text($txt) {
  $cache = Load-Cache
  $proc = Get-Process -Id $cache.pid -ErrorAction SilentlyContinue
  if (-not $proc) { throw '目标进程已退出' }
  $hwnd = $proc.MainWindowHandle
  foreach ($ch in $txt.ToCharArray()) {
    [void][Native]::PostMessage($hwnd, 0x0102, [IntPtr][int][char]$ch, [IntPtr]0)
    Start-Sleep -Milliseconds 30
  }
  Write-Output '{"ok":true}'
}

function Press-Key($name) {
  $map = @{ ENTER = 0x0D; TAB = 0x09; ESC = 0x1B; SPACE = 0x20; BACKSPACE = 0x08 }
  if (-not $map.ContainsKey($name.ToUpper())) { throw "不支持的按键: $name" }
  $vk = $map[$name.ToUpper()]
  $cache = Load-Cache
  $proc = Get-Process -Id $cache.pid -ErrorAction SilentlyContinue
  if (-not $proc) { throw '目标进程已退出' }
  $hwnd = $proc.MainWindowHandle
  [void][Native]::PostMessage($hwnd, 0x0100, [IntPtr]$vk, [IntPtr]0)
  [void][Native]::PostMessage($hwnd, 0x0101, [IntPtr]$vk, [IntPtr]0)
  Write-Output '{"ok":true}'
}

function SelfTest {
  $out = @{ ok = $true; checks = @() }
  function Add-Check($name, $ok, $detail) {
    $script:last = $null
    $out.checks += [pscustomobject]@{ name = $name; ok = $ok; detail = $detail }
    if (-not $ok) { $out.ok = $false }
  }

  Add-Check 'PowerShell' $true $PSVersionTable.PSVersion.ToString()

  try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Check 'UIAutomationClient 程序集' $true 'ok'
  } catch { Add-Check 'UIAutomationClient 程序集' $false $_.Exception.Message }

  try {
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    Add-Check 'UIAutomationTypes 程序集' $true 'ok'
  } catch { Add-Check 'UIAutomationTypes 程序集' $false $_.Exception.Message }

  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    Add-Check '可读桌面根元素' ($null -ne $root) 'ok'
  } catch { Add-Check '可读桌面根元素' $false $_.Exception.Message }

  try {
    $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 3 -ExpandProperty ProcessName
    Add-Check '可枚举窗口进程' ($procs.Count -gt 0) ($procs -join ', ')
  } catch { Add-Check '可枚举窗口进程' $false $_.Exception.Message }

  try {
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Check 'System.Drawing（抓图依赖）' $true 'ok'
  } catch { Add-Check 'System.Drawing（抓图依赖）' $false $_.Exception.Message }

  Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
}
switch ($Command) {
  'snapshot' { Snapshot (Get-TargetProcess) }
  'click'    { Click-Index $Index }
  'type'     { Type-Text $Text }
  'key'      { Press-Key $Key }
  'selftest' { SelfTest }
  default    { throw "未知命令: $Command" }
}