# Analyzing animations offline

**The default is `iphone-capture`** (see SKILL.md, RECORDING): `changes`, `changes --curve N`, `frames`, `sheet`. Import MP4/MOV files from elsewhere (QuickTime, a screen recording made on the iPhone, older recordings) with `iphone-capture import <file>` first; after that the same commands apply.

Use the ffmpeg recipes below only when `iphone-capture` does not fit (e.g. measuring pixels along one specific row). They work for any MP4/MOV with real timestamps, including variable frame rate, and were tested on a synthetic 60 fps clip (a square moving 200 px in 0.5 s with easeOutCubic).

Crop first: the status bar clock, cursors and loading indicators cause unrelated frame changes. So put `crop=W:H:X:Y,` in front of the other filters (pixels of the recording, not iOS points; iPhone 17 Pro: 1206×2622 px = 402×874 pt, factor 3).

## Timestamps of all frames

Fast via packets (0.07 s instead of 2.5 s with `frame=`), then sort:

```sh
ffprobe -v error -select_streams v:0 -show_entries packet=pts_time -of csv=p=0 clip.mp4 | tr -d , | sort -n
```

## Times of frame changes

Prints only frames that visibly differ from the previous one:

```sh
ffmpeg -hide_banner -i clip.mp4 -vf "mpdecimate=hi=64*4:lo=64*2:frac=0.1,showinfo" -fps_mode vfr -f null - 2>&1 | grep -o "pts_time:[0-9.]*"
```

- The motion window runs from the first to the last change after the action.
- Duration = last change − first change + 1 frame interval.
- Small end phases (ease-out) fall below the threshold. Lower `hi`/`lo` for finer detection.
- Caution with real USB clips (H.264): mpdecimate also reports compression noise. In a test with a tab switch it reported 65 changes instead of 11 real ones, and only the window 2.767–2.934 s was the actual motion. Prefer `iphone-capture changes`.

## Single frame at a given time

Returns the first frame at or after T (frame-accurate, because ffmpeg decodes after seeking):

```sh
ffmpeg -v error -ss 0.750 -i clip.mp4 -frames:v 1 -vf scale=302:-2 -update 1 f_0750.png
```

## Contact sheet with real timestamps

A = start time. It appears twice in the command because `-ss` resets the time to 0 and `drawtext` adds it back:

```sh
ffmpeg -v error -ss A -to B -i clip.mp4 -vf "scale=130:-2,drawtext=text='%{pts\:flt\:A}':x=4:y=4:fontsize=14:box=1:boxcolor=yellow,tile=6x5" -frames:v 1 sheet.png
```

- 30 cells equal 0.5 s at 60 fps. The image is 780×1410 px, i.e. ≈1,470 tokens.
- Not `agent-device record contact-sheet`: it samples (short flashes get lost) and costs about 9,700 image tokens.

## Deriving the curve

`iphone-capture changes --curve N` does this automatically. By hand:

1. Measure position, size or opacity of the element at 0, 25, 50, 75 and 100 % of the duration.
2. Compute progress: p = (value − start) / (end − start).
3. Compare with the table [computed]:

| Curve | cubic-bezier | p25 | p50 | p75 |
|---|---|---|---|---|
| linear | 0, 0, 1, 1 | 0.25 | 0.50 | 0.75 |
| easeIn (CSS) | 0.42, 0, 1, 1 | 0.09 | 0.32 | 0.62 |
| easeOut (CSS) | 0, 0, 0.58, 1 | 0.38 | 0.68 | 0.91 |
| easeInOut (UIKit, Flutter, CSS) | 0.42, 0, 0.58, 1 | 0.13 | 0.50 | 0.87 |
| fastOutSlowIn (Flutter, Material) | 0.4, 0, 0.2, 1 | 0.24 | 0.78 | 0.96 |
| easeOutCubic (Flutter) | 0.215, 0.61, 0.355, 1 | 0.60 | 0.88 | 0.98 |

- Test clip measured: 0.60 / 0.87 / 0.98, i.e. easeOutCubic.
- p greater than 1 (overshoot) means a spring. Then note amplitude, number of oscillations and the time until rest.

Measure a position without sending an image to the model: read one pixel row through the element as grayscale and find the first column that differs from the background. Y = row; the threshold 200 works for a dark element on a light background:

```sh
ffmpeg -v error -ss 0.625 -i clip.mp4 -frames:v 1 -vf "crop=iw:1:0:Y,format=gray" -f rawvideo - | python3 -c "import sys;d=sys.stdin.buffer.read();print(next((i for i,v in enumerate(d) if v<200),None))"
```
