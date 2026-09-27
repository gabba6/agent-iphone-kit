# Third-party notices

This repository contains no third-party source code. It works together with the following programs, which are
installed separately and are not redistributed here.

## agent-device

https://github.com/callstack/agent-device – Copyright (c) 2026 Callstack, MIT License.

All device control runs through the agent-device CLI (for example installed with `npm install -g agent-device`);
`iphone-capture` and `iphone-mcp` call it as an external program.

## FFmpeg

https://ffmpeg.org – `ffmpeg` and `ffprobe` are called as external programs for remuxing, frame timing and frame
extraction. FFmpeg is licensed under the LGPL 2.1 or later, with optional GPL parts depending on the build.
FFmpeg is a trademark of Fabrice Bellard, originator of the FFmpeg project.

## Apple frameworks

The USB recording helper (`iphone/helper/usb-screen.swift`) is compiled against Apple's Foundation, AVFoundation
and CoreMediaIO frameworks. No Apple code is included.
