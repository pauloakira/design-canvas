/**
 * Design Canvas document model.
 *
 * The model is intentionally close to CSS so that what you see on the canvas is
 * exactly what the code generator emits. Every container is a flexbox (auto
 * layout) or a positioned box (absolute children), every visual property maps
 * 1:1 to a CSS property.
 *
 * Values that accept design tokens can be written as `"$token-name"`, which
 * resolves to `var(--token-name)` both on the canvas and in exported code.
 */

/** A CSS color (`#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()`, `hsl()`, named) or a token ref `$name`. */
export type Color = string;
/** A number in px, or a token ref `$name`. */
export type Num = number | string;

export type NodeType = 'frame' | 'component' | 'instance' | 'rect' | 'ellipse' | 'text' | 'image' | 'svg';

export type SizeMode = 'fixed' | 'hug' | 'fill';

export interface GradientStop {
  color: Color;
  /** 0..1 */
  position: number;
}

export type Paint =
  | { type: 'solid'; color: Color; visible?: boolean }
  | {
      type: 'gradient';
      kind?: 'linear' | 'radial';
      /** Degrees, CSS convention (180 = top → bottom). */
      angle?: number;
      stops: GradientStop[];
      visible?: boolean;
    }
  | { type: 'image'; src: string; fit?: 'cover' | 'contain' | 'fill'; visible?: boolean };

export interface Stroke {
  color: Color;
  width: number;
  style?: 'solid' | 'dashed' | 'dotted';
  align?: 'inside' | 'center' | 'outside';
}

export interface Shadow {
  type?: 'drop' | 'inner';
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: Color;
  visible?: boolean;
}

export type LayoutMode = 'none' | 'row' | 'column';
export type Justify = 'start' | 'center' | 'end' | 'space-between';
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';

export interface AutoLayout {
  mode: LayoutMode;
  gap?: Num;
  /** [top, right, bottom, left] */
  padding?: [Num, Num, Num, Num];
  /** Main-axis distribution (CSS justify-content). */
  justify?: Justify;
  /** Cross-axis alignment (CSS align-items). */
  align?: Align;
  wrap?: boolean;
}

export interface CodeConnect {
  /** Component name in your codebase, e.g. `Button`. */
  name: string;
  /** Import path, e.g. `@/components/ui/button`. */
  importPath?: string;
  /** Free-form usage notes for LLMs / engineers. */
  notes?: string;
}

export interface BaseNode {
  id: string;
  type: NodeType;
  name: string;
  /** Parent node id, or the page id for top-level nodes. */
  parentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  widthMode?: SizeMode;
  heightMode?: SizeMode;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** In an auto-layout parent: take the node out of the flow. */
  position?: 'auto' | 'absolute';
  rotation?: number;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  fills?: Paint[];
  stroke?: Stroke;
  /** Single radius or [topLeft, topRight, bottomRight, bottomLeft]. */
  radius?: Num | [Num, Num, Num, Num];
  shadows?: Shadow[];
  blur?: number;
  backdropBlur?: number;
  blendMode?: string;
  /** Free-form notes for engineers / LLMs (shown in Dev panel). */
  description?: string;
}

export interface FrameNode extends BaseNode {
  type: 'frame' | 'component';
  children: string[];
  layout?: AutoLayout;
  clip?: boolean;
  /** Only for components: mapping to a component in the codebase. */
  codeConnect?: CodeConnect;
}

export interface InstanceNode extends BaseNode {
  type: 'instance';
  componentId: string;
  /** Overrides keyed by the id of the node inside the main component. */
  overrides?: Record<string, NodeOverride>;
}

export interface NodeOverride {
  text?: string;
  visible?: boolean;
  fills?: Paint[];
  src?: string;
}

export interface ShapeNode extends BaseNode {
  type: 'rect' | 'ellipse';
}

export interface TextNode extends BaseNode {
  type: 'text';
  text: string;
  fontFamily?: string;
  fontSize?: Num;
  fontWeight?: number;
  italic?: boolean;
  /** px number, token, or a CSS string like `"150%"`. Omit for `normal`. */
  lineHeight?: Num;
  letterSpacing?: number;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textDecoration?: 'none' | 'underline' | 'line-through';
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize';
}

export interface ImageNode extends BaseNode {
  type: 'image';
  src: string;
  fit?: 'cover' | 'contain' | 'fill';
  alt?: string;
}

export interface SvgNode extends BaseNode {
  type: 'svg';
  /** Raw SVG markup (sanitized on render). */
  svg: string;
}

export type SceneNode = FrameNode | InstanceNode | ShapeNode | TextNode | ImageNode | SvgNode;

export interface Page {
  id: string;
  name: string;
  children: string[];
  background?: string;
  /** "section": a labeled divider in the page list. It has no layers and can't be opened;
   *  it groups the pages after it, up to the next section. */
  kind?: 'section';
}

export type VariableType = 'color' | 'number' | 'string';

export interface Variable {
  id: string;
  /** CSS-identifier-safe name, e.g. `primary`, `gray-100`, `space-4`. */
  name: string;
  type: VariableType;
  value: string | number;
  group?: string;
  description?: string;
}

export interface CommentMessage {
  id: string;
  author: string;
  authorKind?: 'user' | 'agent';
  text: string;
  createdAt: number;
  editedAt?: number;
}

/**
 * A comment thread pinned on the canvas. When `nodeId` is set the pin follows
 * that layer and (x, y) is the offset from its top-left corner; otherwise (x, y)
 * are page coordinates.
 */
export interface CommentThread {
  id: string;
  /** Sequential number shown on the pin (#1, #2…). */
  number: number;
  pageId: string;
  nodeId?: string;
  x: number;
  y: number;
  /** Page coordinates at creation — fallback if the layer is deleted. */
  pageX: number;
  pageY: number;
  messages: CommentMessage[];
  resolved?: boolean;
  resolvedBy?: string;
  createdAt: number;
}

export interface DesignDoc {
  id: string;
  name: string;
  schema: 1;
  createdAt: number;
  updatedAt: number;
  pageOrder: string[];
  pages: Record<string, Page>;
  nodes: Record<string, SceneNode>;
  variables: Record<string, Variable>;
  comments: Record<string, CommentThread>;
}

/** Whole-object replacement patch. `null` deletes. */
export interface DocPatch {
  nodes?: Record<string, SceneNode | null>;
  pages?: Record<string, Page | null>;
  pageOrder?: string[];
  variables?: Record<string, Variable | null>;
  comments?: Record<string, CommentThread | null>;
  name?: string;
}

export interface DocMeta {
  id: string;
  name: string;
  /** Folder path relative to the designs dir ('' = root), e.g. "Marketing/Landing". */
  folder: string;
  updatedAt: number;
  createdAt: number;
  pages: number;
  nodes: number;
}

export type Origin =
  | { kind: 'user'; clientId: string; name?: string }
  | { kind: 'agent'; name: string; tool?: string }
  | { kind: 'system' };

export type FrameLike = FrameNode;
