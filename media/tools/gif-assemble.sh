#!/bin/sh
# frames from gif.mjs (../frames/gif/f*.jpg) -> a small GIF
set -e
cd "$(dirname "$0")/.."
FF="${FFMPEG:-ffmpeg}"
# the capture is slower than real time (a software GL render per frame), so playback speed is chosen, not measured:
# every second frame at 8 fps, 720 px wide, 80 colours
N=$(ls frames/gif/f*.jpg | wc -l)
echo "frames $N"
"$FF" -y -loglevel error -framerate 16 -i frames/gif/f%04d.jpg -vf "select='not(mod(n,2))',setpts=N/(8*TB),scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=80:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -r 8 -loop 0 overhang.gif
ls -la overhang.gif
