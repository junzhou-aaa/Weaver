const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const AUDIO_DIR = path.join(__dirname, 'audio');

console.log('🚀 Starting pre-generation of 5 tracks...');

for (let i = 1; i <= 5; i++) {
  console.log(`\n========================================`);
  console.log(`🎵 Generating Track ${i} of 5...`);
  console.log(`========================================`);
  
  // 1. Run splice.js to generate merged.wav
  execSync('node splice.js', { stdio: 'inherit' });
  
  // 2. Run analyze.js to generate events.json
  execSync('node analyze.js', { stdio: 'inherit' });
  
  // 3. Rename files for this track
  const trackWav = path.join(AUDIO_DIR, `track_${i}.wav`);
  const trackJson = path.join(AUDIO_DIR, `events_${i}.json`);
  
  fs.renameSync(path.join(AUDIO_DIR, 'merged.wav'), trackWav);
  fs.renameSync(path.join(AUDIO_DIR, 'events.json'), trackJson);
  
  console.log(`✅ Successfully saved as track_${i}.wav and events_${i}.json`);
}

console.log('\n🎉 All 5 tracks have been pre-generated successfully!');
