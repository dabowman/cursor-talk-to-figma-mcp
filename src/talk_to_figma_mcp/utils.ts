// Custom logging functions that write to stderr instead of stdout to avoid being captured
export const logger = {
  info: (message: string) => process.stderr.write(`[INFO] ${message}\n`),
  debug: (message: string) => process.stderr.write(`[DEBUG] ${message}\n`),
  warn: (message: string) => process.stderr.write(`[WARN] ${message}\n`),
  error: (message: string) => process.stderr.write(`[ERROR] ${message}\n`),
  log: (message: string) => process.stderr.write(`[LOG] ${message}\n`),
};

export function rgbaToHex(color: any): string {
  // skip if color is already a string (e.g. hex)
  if (typeof color === "string") {
    return color;
  }

  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.round(color.a * 255);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}${a === 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

export function filterFigmaNode(node: any, depth = Number.POSITIVE_INFINITY) {
  // Skip VECTOR type nodes
  if (node.type === "VECTOR") {
    return null;
  }

  const filtered: any = {
    id: node.id,
    name: node.name,
    type: node.type,
  };

  if (node.fills && node.fills.length > 0) {
    filtered.fills = node.fills.map((fill: any) => {
      const processedFill = { ...fill };

      // Remove boundVariables and imageRef
      delete processedFill.boundVariables;
      delete processedFill.imageRef;

      // Process gradientStops if present
      if (processedFill.gradientStops) {
        processedFill.gradientStops = processedFill.gradientStops.map((stop: any) => {
          const processedStop = { ...stop };
          // Convert color to hex if present
          if (processedStop.color) {
            processedStop.color = rgbaToHex(processedStop.color);
          }
          // Remove boundVariables
          delete processedStop.boundVariables;
          return processedStop;
        });
      }

      // Convert solid fill colors to hex
      if (processedFill.color) {
        processedFill.color = rgbaToHex(processedFill.color);
      }

      return processedFill;
    });
  }

  if (node.strokes && node.strokes.length > 0) {
    filtered.strokes = node.strokes.map((stroke: any) => {
      const processedStroke = { ...stroke };
      // Remove boundVariables
      delete processedStroke.boundVariables;
      // Convert color to hex if present
      if (processedStroke.color) {
        processedStroke.color = rgbaToHex(processedStroke.color);
      }
      return processedStroke;
    });
  }

  if (node.cornerRadius !== undefined) {
    filtered.cornerRadius = node.cornerRadius;
  }

  if (node.absoluteBoundingBox) {
    filtered.absoluteBoundingBox = node.absoluteBoundingBox;
  }

  if (node.characters) {
    filtered.characters = node.characters;
  }

  if (node.style) {
    filtered.style = {
      fontFamily: node.style.fontFamily,
      fontStyle: node.style.fontStyle,
      fontWeight: node.style.fontWeight,
      fontSize: node.style.fontSize,
      textAlignHorizontal: node.style.textAlignHorizontal,
      letterSpacing: node.style.letterSpacing,
      lineHeightPx: node.style.lineHeightPx,
    };
  }

  // Auto-layout properties (REST API format from exportAsync JSON_REST_V1)
  if (node.layoutMode && node.layoutMode !== "NONE") {
    filtered.layoutMode = node.layoutMode;
    filtered.primaryAxisSizingMode = node.primaryAxisSizingMode;
    filtered.counterAxisSizingMode = node.counterAxisSizingMode;
    if (node.primaryAxisAlignItems && node.primaryAxisAlignItems !== "MIN") {
      filtered.primaryAxisAlignItems = node.primaryAxisAlignItems;
    }
    if (node.counterAxisAlignItems && node.counterAxisAlignItems !== "MIN") {
      filtered.counterAxisAlignItems = node.counterAxisAlignItems;
    }
    if (node.itemSpacing > 0) {
      filtered.itemSpacing = node.itemSpacing;
    }
    if (node.counterAxisSpacing > 0) {
      filtered.counterAxisSpacing = node.counterAxisSpacing;
    }
    if (node.paddingLeft > 0) {
      filtered.paddingLeft = node.paddingLeft;
    }
    if (node.paddingRight > 0) {
      filtered.paddingRight = node.paddingRight;
    }
    if (node.paddingTop > 0) {
      filtered.paddingTop = node.paddingTop;
    }
    if (node.paddingBottom > 0) {
      filtered.paddingBottom = node.paddingBottom;
    }
    if (node.layoutWrap === "WRAP") {
      filtered.layoutWrap = node.layoutWrap;
    }
  }

  if (node.children) {
    if (depth <= 0) {
      filtered.childCount = node.children.length;
    } else {
      filtered.children = node.children
        .map((child: any) => filterFigmaNode(child, depth - 1))
        .filter((child: any) => child !== null); // Remove null children (VECTOR nodes)
    }
  }

  return filtered;
}
