ObjC.import('AppKit');

// Exports each app's Finder icon as a square PNG. argv: JSON [{path,file}], output directory, pixel size.
function run(argv) {
  const [listJson, outDir, sizeArg] = argv;
  const size = Number(sizeArg) || 128;
  const workspace = $.NSWorkspace.sharedWorkspace;
  const results = [];
  for (const app of JSON.parse(listJson)) {
    const icon = workspace.iconForFile(app.path);
    const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, size, size, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(context);
    icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
    $.NSGraphicsContext.restoreGraphicsState;
    const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
    const file = outDir + '/' + app.file;
    results.push({ file: app.file, ok: Boolean(png.writeToFileAtomically(file, true)) });
  }
  return JSON.stringify(results);
}
