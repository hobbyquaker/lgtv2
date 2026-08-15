# Agent rules

- Always run commands through WSL (Debian), never PowerShell/cmd. This avoids issues with binary dependencies and CRLF line breaks.
    - Use `wsl.exe -d Debian -- bash -lc '<cmd>'` (or the Bash tool) and work from `/home/basti/repos/lgtv2`, not the `\wsl.localhost` UNC path.
