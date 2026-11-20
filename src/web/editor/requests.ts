import { captureScreenshot } from './screenshot.ts';
import { htmlToSpec } from './importHtml.ts';

/** Requests from the server that need a real browser (screenshots, HTML layout). */
export async function handleEditorRequest(kind: string, payload: any): Promise<unknown> {
  switch (kind) {
    case 'screenshot':
      return captureScreenshot(payload ?? {});
    case 'import-html':
      return { spec: await htmlToSpec(String(payload?.html ?? ''), Number(payload?.width ?? 1440), String(payload?.name ?? 'Imported')) };
    default:
      throw new Error(`Unknown editor request "${kind}"`);
  }
}
