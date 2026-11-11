import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures/content/content.json'), 'utf8')
);

const errors = [];
for (const video of dataset.videos) {
  const mediaDir = path.join(root, 'fixtures/dash', video.videoId);
  const mpdPath = path.join(mediaDir, 'manifest.mpd');
  if (!fs.existsSync(mpdPath)) {
    errors.push(`${video.videoId}: missing manifest.mpd`);
    continue;
  }

  const mpd = fs.readFileSync(mpdPath, 'utf8');
  const videoOnly = path.join(mediaDir, 'manifest-video-only.mpd');
  if (!fs.existsSync(videoOnly)) {
    errors.push(`${video.videoId}: missing video-only MPD`);
  } else {
    const videoMpd = fs.readFileSync(videoOnly, 'utf8');
    if (
      /contentType=["']audio["']/.test(videoMpd) ||
      !/contentType=["']video["']/.test(videoMpd) ||
      (videoMpd.match(/<Representation /g) ?? []).length !==
        (video.representations.video ?? []).length
    ) {
      errors.push(`${video.videoId}: invalid video-only MPD adaptation sets`);
    }
  }
  const manifestBytes = fs.statSync(mpdPath).size;
  if (manifestBytes !== video.manifestBytes) {
    errors.push(
      `${video.videoId}: manifest size ${manifestBytes} != dataset ${video.manifestBytes}`
    );
  }

  for (const [mediaType, representations] of Object.entries(video.representations)) {
    for (const representation of representations) {
      const idPattern = new RegExp(
        `<Representation\\s+id=["']${representation.id}["'][\\s\\S]*?bandwidth=["']${
          representation.bitrateKbps * 1000
        }["']`
      );
      if (!idPattern.test(mpd)) {
        errors.push(
          `${video.videoId}/${mediaType}: representation ${representation.id} not aligned with MPD`
        );
      }

      const initPath = path.join(mediaDir, path.basename(representation.initUrl));
      if (!fs.existsSync(initPath)) {
        errors.push(`${video.videoId}/${representation.id}: missing init segment`);
      } else if (fs.statSync(initPath).size !== representation.initBytes) {
        errors.push(`${video.videoId}/${representation.id}: init byte size mismatch`);
      }

      for (const segment of representation.segments) {
        const segmentPath = path.join(mediaDir, path.basename(segment.url));
        if (!fs.existsSync(segmentPath)) {
          errors.push(`${video.videoId}/${representation.id}/${segment.index}: missing segment`);
        } else if (fs.statSync(segmentPath).size !== segment.bytes) {
          errors.push(`${video.videoId}/${representation.id}/${segment.index}: byte size mismatch`);
        }
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

console.log(`fixtures: ok (${dataset.videos.length} DASH assets)`);
