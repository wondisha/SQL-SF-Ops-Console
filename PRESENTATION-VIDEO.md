# MP4 Presentation Asset

This repository includes a reproducible MP4 generator for a polished presentation video:

- **Generator script:** `/scripts/generate-presentation-video.sh`
- **Source scene copy:** `/assets/presentation/video/scenes/*.txt`
- **Output file (default):** `/assets/video/omnidb-console-presentation.mp4`

## Generate the MP4

```bash
# from repository root
npm run video:presentation
```

Or choose a custom output path:

```bash
bash ./scripts/generate-presentation-video.sh /absolute/path/to/omnidb-console-presentation.mp4
```

## What the video covers

The generated presentation is built for technical and non-technical audiences and includes:

- Clear title and project positioning
- Problem statement (fragmented multi-engine operations)
- Unified console value across SQL Server, Snowflake, PostgreSQL, MySQL, and IBM DB2
- Key features and telemetry capabilities
- Demo-safe simulation mode
- Security and governance posture
- FinOps visibility and enterprise readiness

## Requirements

- `ffmpeg` installed locally and available in your `PATH`
- Linux/macOS shell environment (or Git Bash/WSL on Windows)

The visual style uses the same dark enterprise palette used by the console UI.
