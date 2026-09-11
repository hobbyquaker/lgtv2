# Agent rules

- Always run commands through WSL (Debian), never PowerShell/cmd. This avoids issues with binary dependencies and CRLF line breaks.
    - Use `wsl.exe -d Debian -- bash -lc '<cmd>'` (or the Bash tool) and work from `/home/basti/repos/lgtv2`, not the `\wsl.localhost` UNC path.

## GitHub CLI

- This repo is a GitHub fork of `msloth/lgtv.js`; `gh` would otherwise resolve to the parent. The default is pinned (`gh repo set-default hobbyquaker/lgtv2`); always pass `-R hobbyquaker/lgtv2` anyway and never touch the upstream repo.

## Roadmap

- The roadmap — items, decisions (L-n), open questions (OQ-n, fleet numbering) and the appendices with their original section numbers (0 local patches, 1 analysis of 1.6.3, 2 target API) — is kept in the maintainer's agents repository, checked out next to this one as `../she-agent/roadmap-items/lgtv2/`. It is not part of this repository.
