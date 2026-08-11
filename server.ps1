Add-Type -AssemblyName System.Web
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://localhost:8000/')
$listener.Start()
Write-Host 'Server started on http://localhost:8000/'
$root = 'd:\Trae CN\trae_projects\beidanci'
while ($listener.IsListening) {
  $context = $listener.GetContext()
  $path = $context.Request.Url.LocalPath
  if ($path -eq '/') { $path = '/index.html' }
  $fullPath = Join-Path $root $path.TrimStart('/')
  if (Test-Path $fullPath -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($fullPath)
    switch ($ext) {
      '.html' { $context.Response.ContentType = 'text/html; charset=utf-8' }
      '.js'   { $context.Response.ContentType = 'application/javascript; charset=utf-8' }
      '.css'  { $context.Response.ContentType = 'text/css; charset=utf-8' }
      '.json' { $context.Response.ContentType = 'application/json; charset=utf-8' }
      '.png'  { $context.Response.ContentType = 'image/png' }
      '.jpg'  { $context.Response.ContentType = 'image/jpeg' }
      '.svg'  { $context.Response.ContentType = 'image/svg+xml' }
      default { $context.Response.ContentType = 'application/octet-stream' }
    }
    $bytes = [System.IO.File]::ReadAllBytes($fullPath)
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $context.Response.StatusCode = 404
  }
  $context.Response.Close()
}
