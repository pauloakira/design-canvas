/** Instructions shared by the MCP server and the in-app AI agents. */
export const DESIGN_GUIDE = `Design Canvas is a local, Figma-like design tool whose documents map 1:1 to HTML/CSS (flexbox). You can read designs (to implement them in code) and create/edit designs (to design UIs).

DOCUMENT MODEL
- Document → pages → node tree. Node types: frame (container; optional auto layout = flexbox), component (reusable frame), instance (live copy of a component), rect, ellipse, text, image, svg (icons/vectors as raw SVG markup).
- x/y are relative to the parent. Children of an auto-layout frame are placed by the layout (x/y ignored) unless position:"absolute".
- Size: width/height in px. widthMode/heightMode: "fixed" | "hug" (fit content) | "fill" (stretch inside an auto-layout parent). Shorthand: width:"fill", height:"hug".
- Auto layout: layout:{mode:"row"|"column", gap, padding: n | [vertical,horizontal] | [top,right,bottom,left], justify:"start"|"center"|"end"|"space-between", align:"start"|"center"|"end"|"stretch", wrap:boolean}. Shorthands on frames: direction, gap, padding, justify, align.
- Fill: fill:"#RRGGBB" or fills:[{type:"solid",color}, {type:"gradient",angle,stops:[{color,position:0..1}]}, {type:"image",src,fit:"cover"}]. Text color: color:"#hex".
- stroke:{color,width,align:"inside"|"center"|"outside",style:"solid"|"dashed"} or "1px solid #E5E7EB"; radius: n | [tl,tr,br,bl]; shadows:[{x,y,blur,spread,color,type:"drop"|"inner"}] or a CSS box-shadow string; opacity 0–1; blur; backdropBlur; clip:true (overflow hidden).
- Text: text, fontFamily (Inter, Roboto, Geist, DM Sans, Poppins, Manrope, Space Grotesk, IBM Plex Sans, JetBrains Mono, Playfair Display…), fontSize, fontWeight 100–900, lineHeight (px or "150%"), letterSpacing (px), textAlign, textDecoration, textTransform. Text hugs its content by default; give it width (or width:"fill") to wrap.
- Image: src (URL or /assets/... path), fit. SVG: svg:"<svg viewBox=...>...</svg>" (use stroke="currentColor"-free explicit colors).
- Design tokens: set_variables creates variables; reference them anywhere as "$name" (fill:"$primary", gap:"$space-4", radius:"$radius-md", fontSize:"$text-lg"). They export as CSS custom properties.
- Components: create_component turns a frame into a component; create_instance places copies that update when the component changes. Override instance text with update_nodes [{id:<instanceId>, overrides:{"<componentChildId>":{text:"…"}}}]. A component's codeConnect {name, importPath} maps it to a component in the codebase so generated code uses <Name/>.

DESIGNING
- Build complete screens in ONE create_nodes call using nested children. Use auto layout for nearly everything (it becomes flexbox); absolute positioning only for overlays/badges.
- Screen roots: frame width 1440 (desktop) / 390 (mobile), fill "#FFFFFF", layout column, height "hug" (or fixed 1024/844). Top-level frames are auto-placed to the right of existing content when x/y are omitted.
- Use a consistent 4/8px spacing scale, a clear type scale, real copy (no lorem ipsum), and semantic layer names (e.g. "Header", "PrimaryButton", "PricingCard") — engineers will see them as component names.
- Prefer creating tokens (colors, spacing, radii) first with set_variables and referencing them, so code generation emits CSS variables.
- After significant changes call get_screenshot on the root frame to visually check the result, then fix problems with update_nodes.

IMPLEMENTING A DESIGN IN CODE
- get_selection tells you what the user is pointing at. get_design_context returns React+Tailwind (or HTML/CSS) reference code, tokens, fonts, assets and mapped components for a node. get_screenshot shows how it looks.
- Treat generated code as a precise reference, not final code: reuse the project's existing components, tokens and conventions; replace absolute values with the project's theme where they match.`;
