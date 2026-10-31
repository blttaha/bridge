# Test target inside Windows Sandbox: records what the agent's input actually did to a real window.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$state = @{ clicks = 0; rightClicks = 0; doubleClicks = 0 }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Bridge touch test'
$form.WindowState = 'Maximized'
$form.FormBorderStyle = 'None'
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 40)

$btn = New-Object System.Windows.Forms.Button
$btn.Text = 'TAP'
$btn.Font = New-Object System.Drawing.Font('Segoe UI', 28)
$btn.BackColor = [System.Drawing.Color]::LightGreen
$btn.Add_Click({ $state.clicks++ })
$btn.Add_MouseUp({ param($s, $e) if ($e.Button -eq 'Right') { $state.rightClicks++ } })
$form.Controls.Add($btn)

$list = New-Object System.Windows.Forms.ListBox
$list.Font = New-Object System.Drawing.Font('Segoe UI', 16)
for ($i = 0; $i -lt 400; $i++) { [void]$list.Items.Add("Satır $i") }
$form.Controls.Add($list)

$text = New-Object System.Windows.Forms.TextBox
$text.Font = New-Object System.Drawing.Font('Segoe UI', 20)
$form.Controls.Add($text)

$layout = {
  $w = $form.ClientSize.Width; $h = $form.ClientSize.Height
  $btn.SetBounds([int]($w * 0.05), [int]($h * 0.10), [int]($w * 0.40), [int]($h * 0.40))
  $text.SetBounds([int]($w * 0.05), [int]($h * 0.60), [int]($w * 0.40), [int]($h * 0.08))
  $list.SetBounds([int]($w * 0.55), [int]($h * 0.10), [int]($w * 0.40), [int]($h * 0.80))
}
$form.Add_Shown($layout)
$form.Add_Resize($layout)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({
  $o = [ordered]@{
    clicks = $state.clicks; rightClicks = $state.rightClicks; topIndex = $list.TopIndex; text = $text.Text
    width = $form.ClientSize.Width; height = $form.ClientSize.Height; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  }
  try { ($o | ConvertTo-Json -Compress) | Set-Content -Path 'C:\tb\out\ui-state.json' -Encoding UTF8 } catch {}
})
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
