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
      $pattern = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        $pattern.Invoke(); Write-Output '{"ok":true,"method":"invoke"}'; return
      }
      if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
        $pattern.Select(); Write-Output '{"ok":true,"method":"select"}'; return
      }
      # 兜底：把焦点移过去再发回车（不移动鼠标）
      $el.SetFocus()
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

switch ($Command) {
  'snapshot' { Snapshot (Get-TargetProcess) }
  'click'    { Click-Index $Index }
  'type'     { Type-Text $Text }
  'key'      { Press-Key $Key }
  default    { throw "未知命令: $Command" }
}
