import fs from 'fs';
import path from 'path';

const read = relativePath =>
  fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('Android application identity', () => {
  it('uses the requested application ID and native package', () => {
    const gradle = read('android/app/build.gradle');
    const application = read('android/app/src/main/java/com/xiaoyaco3/MainApplication.kt');
    expect(gradle).toContain('namespace "com.xiaoyaco3"');
    expect(gradle).toContain('applicationId "com.xiaoyaco3"');
    expect(application).toContain('package com.xiaoyaco3');
  });

  it('uses the supplied logo for adaptive icons', () => {
    const icon = read('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml');
    expect(icon).toContain('@drawable/ic_launcher_logo');
    expect(fs.existsSync(path.join(__dirname, '..', 'android/app/src/main/res/drawable-nodpi/lgoo.png'))).toBe(true);
  });
});
