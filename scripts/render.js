ObjC.import('AppKit');

const rect = (x, y, w, h) => $.NSMakeRect(x, y, w, h);
const rgb = (r, g, b, a = 1) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(r, g, b, a);
const fill = (frame, color) => { color.setFill; $.NSBezierPath.bezierPathWithRect(frame).fill; };
const gradient = (frame, from, to, angle) => $.NSGradient.alloc.initWithStartingColorEndingColor(from, to).drawInRectAngle(frame, angle);

function attributes(fontName, size, color, shadow) {
  const attrs = $.NSMutableDictionary.alloc.init;
  const font = $.NSFont.fontWithNameSize(fontName, size);
  attrs.setObjectForKey(font.isNil() ? $.NSFont.systemFontOfSize(size) : font, $('NSFont'));
  attrs.setObjectForKey(color, $('NSColor'));
  if (shadow) {
    const shade = $.NSShadow.alloc.init;
    shade.shadowColor = rgb(0, 0, 0, .82);
    shade.shadowBlurRadius = 5;
    shade.shadowOffset = $.NSMakeSize(0, -1);
    attrs.setObjectForKey(shade, $('NSShadow'));
  }
  return attrs;
}

// centered: true centers on x, 'right' right-aligns to x, otherwise x is the left edge.
function drawText(text, font, size, minimum, maxWidth, x, y, centered, color, shadow) {
  let attrs = attributes(font, size, color, shadow);
  let measured = $(text).sizeWithAttributes(attrs).width;
  while (measured > maxWidth && size > minimum) {
    size -= 0.5;
    attrs = attributes(font, size, color, shadow);
    measured = $(text).sizeWithAttributes(attrs).width;
  }
  const letters = Array.from(text);
  while (measured > maxWidth && letters.length > 1) {
    letters.pop();
    text = letters.join('') + '…';
    measured = $(text).sizeWithAttributes(attrs).width;
  }
  const left = centered === 'right' ? x - measured : centered ? x - measured / 2 : x;
  $(text).drawAtPointWithAttributes($.NSMakePoint(left, y), attrs);
}

function wallpaperFor(workspace, override) {
  if (override) return workspaceFile(override);
  const screen = $.NSScreen.mainScreen;
  if (screen.isNil()) return null;
  const url = workspace.desktopImageURLForScreen(screen);
  if (url.isNil()) return null;
  return workspaceFile(ObjC.unwrap(url.path));
}

function workspaceFile(path) {
  const image = $.NSImage.alloc.initWithContentsOfFile(path);
  return image.isNil() ? null : image;
}

function drawBackground(workspace, width, height, style, override) {
  const frame = rect(0, 0, width, height);
  fill(frame, rgb(.06, .10, .14));
  const image = style === 'minimal' ? null : wallpaperFor(workspace, override);
  if (override && style !== 'minimal' && !image) throw Error('无法读取指定的桌面背景。');
  if (image) {
    const source = image.size;
    const scale = Math.min(source.width / width, source.height / height);
    const cropWidth = width * scale;
    const cropHeight = height * scale;
    image.drawInRectFromRectOperationFraction(frame, rect((source.width - cropWidth) / 2, (source.height - cropHeight) / 2, cropWidth, cropHeight), $.NSCompositingOperationSourceOver, 1);
    const opacity = style === 'night' ? .58 : .30;
    fill(frame, rgb(.04, .07, .11, opacity));
    gradient(frame, rgb(.04, .07, .13, .38), rgb(.07, .11, .16, .13), 0);
    gradient(frame, rgb(.03, .05, .08, .53), rgb(.03, .05, .08, .08), 90);
  } else {
    gradient(frame, rgb(.06, .16, .22), rgb(.21, .33, .31), 28);
    gradient(frame, rgb(.04, .075, .13, .72), rgb(.05, .08, .12, .08), 90);
  }
  return Boolean(image);
}

function grouped(apps) {
  const groups = {};
  const order = [];
  for (const app of apps) {
    const key = 'group:' + app.group;
    if (!groups[key]) { groups[key] = []; order.push({ label: app.group, apps: groups[key] }); }
    groups[key].push(app);
  }
  const rows = [];
  for (const group of order) {
    for (let start = 0; start < group.apps.length; start += 11) {
      rows.push({ label: start === 0 ? group.label : '', apps: group.apps.slice(start, start + 11) });
    }
  }
  return rows;
}

function run(argv) {
  const selection = JSON.parse(argv[0]);
  const [file, style, wallpaper] = argv.slice(1);
  const workspace = $.NSWorkspace.sharedWorkspace;
  const width = 1200;
  const rows = grouped(selection.apps);
  const rowHeight = rows.length <= 5 ? Math.min(111, Math.floor(498 / rows.length)) : 90;
  const footer = 34;
  const height = Math.max(675, 159 + footer + rows.length * rowHeight);
  const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, width * 2, height * 2, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
  );
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  const transform = $.NSAffineTransform.transform;
  transform.scaleBy(2);
  transform.concat;
  const usedWallpaper = drawBackground(workspace, width, height, style, wallpaper);
  const white = rgb(.997, .986, .959);
  const columns = Math.max(6, ...rows.map(row => row.apps.length));
  const labelWidth = 148;
  const step = (width - labelWidth - 96) / columns;
  const iconSize = Math.min(64, rowHeight * .62);
  // Titles that already name a year (e.g. "2026 AI 开发工作台") are drawn as-is so the year is not doubled.
  const hasYear = /(^|[^0-9])(19|20|21)[0-9]{2}([^0-9]|$)/.test(selection.title);
  const heading = selection.year && !hasYear ? String(selection.year) + '  ' + selection.title : selection.title;
  drawText(heading, 'STSongti-SC-Bold', 53, 32, 1096, 48, height - 111, false, white, true);
  const quiet = rgb(.997, .986, .959, .72);
  drawText('software.qiaomu.ai', 'AvenirNext-Medium', 14, 11, 260, width - 48, 24, 'right', quiet, true);
  if (selection.author) drawText(selection.author + (/[A-Za-z0-9]$/.test(selection.author) ? ' ' : '') + '的推荐', 'PingFangSC-Medium', 15, 11, 520, 48, 23, false, quiet, true);
  rows.forEach((row, index) => {
    const top = height - 137 - index * rowHeight;
    drawText(row.label, 'STSongti-SC-Bold', 23, 13, labelWidth - 16, 48, top - 45, false, white, true);
    row.apps.forEach((app, col) => {
      const x = 48 + labelWidth + step * (col + .5);
      const icon = workspace.iconForFile(app.path);
      icon.drawInRectFromRectOperationFraction(rect(x - iconSize / 2, top - iconSize, iconSize, iconSize), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      drawText(app.name, 'AvenirNext-DemiBold', 15, 10, step - 8, x, top - iconSize - 19, true, white, true);
    });
  });
  $.NSGraphicsContext.restoreGraphicsState;
  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  if (!png.writeToFileAtomically(file, true)) throw Error('无法写入海报。');
  return JSON.stringify({ image: file, width: width * 2, height: height * 2, included: selection.apps.length, wallpaper: usedWallpaper });
}
