#!/usr/bin/env bash
# Embeds the ASCII diagram block from each .txt source file into
# the corresponding .html diagram file as a <script type="text/plain" id="ascii-source"> tag.
#
# Usage: ./scripts/embed-ascii-source.sh

set -euo pipefail

DIRS=("ascii2" "ascii3" "ascii4")

for dir in "${DIRS[@]}"; do
  ASCII_DIR="docs/diagram/ascii/$dir"
  HTML_DIR="diagrams/$dir"

  if [[ ! -d "$ASCII_DIR" ]] || [[ ! -d "$HTML_DIR" ]]; then
    echo "SKIP dir: $dir (missing $ASCII_DIR or $HTML_DIR)"
    continue
  fi

  for txt in "$ASCII_DIR"/*.txt; do
    base="$(basename "$txt" .txt)"
    html="$HTML_DIR/$base.html"

    if [[ ! -f "$html" ]]; then
      echo "SKIP: $html not found"
      continue
    fi

    # Extract the diagram block (between ```diagram and the next ```)
    diagram_block=$(sed -n '/^```diagram$/,/^```$/{/^```/d;p}' "$txt")

    if [[ -z "$diagram_block" ]]; then
      echo "SKIP: no diagram block in $txt"
      continue
    fi

    # Remove any existing ascii-source script tag
    sed -i '/<script type="text\/plain" id="ascii-source">/,/<\/script>/d' "$html"

    # Insert before </body>
    sed -i "/<\/body>/i\\
<script type=\"text/plain\" id=\"ascii-source\">\\
</script>" "$html"

    # Now insert the actual content between the script tags
    # Use a temp file to handle multiline content safely
    tmp=$(mktemp)
    awk -v content_file="$txt" '
      /<script type="text\/plain" id="ascii-source">/ {
        print
        # Read and print diagram block from source file
        in_block = 0
        while ((getline line < content_file) > 0) {
          if (line == "```diagram") { in_block = 1; continue }
          if (in_block && line == "```") { in_block = 0; break }
          if (in_block) print line
        }
        close(content_file)
        next
      }
      { print }
    ' "$html" > "$tmp"
    mv "$tmp" "$html"

    echo "OK: $dir/$base"
  done
done
