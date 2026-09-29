#!/bin/sh
# Give app.js and style.css a content-based ?v= in index.html, so browsers never pair
# a new page with an old cached script (GitHub Pages caches files for 10 minutes).
# Run before committing changes to app.js or style.css.
cd "$(dirname "$0")/.." || exit 1
for f in app.js style.css; do
  v=$(shasum "$f" | cut -c1-8)
  sed -i '' -E "s#(\"$f)(\\?v=[0-9a-f]+)?\"#\\1?v=$v\"#" index.html
done
grep -E 'app\.js|style\.css' index.html
