import { describe, expect, it, vi } from 'vitest';
import { readBoundedText } from './requestBody';

function streamedRequest(body: ReadableStream<Uint8Array>): Request {
  // Node requires duplex for a request stream. Workers does not.
  const init = { method: 'POST', body, duplex: 'half' };
  return new Request('https://shop.example', init);
}

describe('readBoundedText', () => {
  it('counts UTF-8 bytes and decodes characters split across chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xc3]));
        controller.enqueue(new Uint8Array([0xa9]));
        controller.close();
      },
    });
    const request = streamedRequest(stream);
    await expect(readBoundedText(request, 2)).resolves.toBe('é');
  });

  it('cancels an oversized stream with no declared length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    const request = streamedRequest(stream);
    await expect(readBoundedText(request, 3)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});
