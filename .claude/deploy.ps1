$input_json = [Console]::In.ReadToEnd()
$data = $input_json | ConvertFrom-Json
$file = if ($data.tool_input.file_path) { $data.tool_input.file_path } else { $data.tool_response.filePath }
if (-not $file) { exit 0 }
$tracker = "C:/Users/1/Sync/Claude PST/task-tracker"
if ($file -notlike "$tracker*") { exit 0 }
Set-Location $tracker
git add -A 2>$null
$status = git status --porcelain 2>$null
if (-not $status) { exit 0 }
git commit -m "Update task tracker" 2>$null
git push origin master 2>$null
