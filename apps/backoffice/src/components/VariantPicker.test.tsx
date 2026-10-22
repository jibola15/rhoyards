import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { VariantLookup } from '@rhoyards/shared';
import { createQueryClient } from '../lib/query-client';
import { json, mockApi } from '../test/render';
import { VariantPicker } from './VariantPicker';

const variant = (id: string, sku: string): VariantLookup =>
  ({ id, sku, name: '100 g', productName: `Product ${id}`, sellingPrice: '1000.00', qtyOnHand: null }) as unknown as VariantLookup;

function renderPicker(onSelect: (v: VariantLookup, qty: string) => void, captureScans = false, withQty = false) {
  render(
    <QueryClientProvider client={createQueryClient({ retry: false })}>
      <button type="button">Elsewhere</button>
      <VariantPicker label="Scan" onSelect={onSelect} captureScans={captureScans} withQty={withQty} />
    </QueryClientProvider>,
  );
  return screen.getByRole('combobox', { name: 'Scan' }) as HTMLInputElement;
}

/** A scanner: the characters in one quick burst, then the suffix key. */
function scanInto(input: HTMLInputElement, code: string, suffix = 'Enter') {
  for (const ch of code) {
    fireEvent.keyDown(input, { key: ch });
    fireEvent.change(input, { target: { value: input.value + ch } });
  }
  fireEvent.keyDown(input, { key: suffix });
}

describe('VariantPicker with a barcode scanner', () => {
  it('adds every scan in order, even when the next code arrives before the first lookup answers', async () => {
    let releaseFirst!: () => void;
    const firstAnswered = new Promise<void>((r) => (releaseFirst = r));
    mockApi({
      'GET /variants/by-code/1111111111111': async () => {
        await firstAnswered;
        return json(200, { data: variant('a', 'SKU-A') });
      },
      'GET /variants/by-code/2222222222222': () => json(200, { data: variant('b', 'SKU-B') }),
    });
    const onSelect = vi.fn();
    const input = renderPicker(onSelect);

    scanInto(input, '1111111111111');
    expect(input.value).toBe(''); // cleared at once, ready for the next scan
    scanInto(input, '2222222222222');
    releaseFirst();

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(onSelect.mock.calls.map(([v]) => (v as VariantLookup).sku)).toEqual(['SKU-A', 'SKU-B']);
  });

  it('accepts a Tab suffix after a fast burst, and reports an unknown code', async () => {
    mockApi({
      'GET /variants/by-code/5012345678900': () => json(200, { data: variant('c', 'SKU-C') }),
      'GET /variants/by-code/9999999999999': () => json(404, { error: { code: 'NOT_FOUND', message: 'Variant not found' } }),
    });
    const onSelect = vi.fn();
    const input = renderPicker(onSelect);

    scanInto(input, '5012345678900', 'Tab');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU-C' }), '1'));

    scanInto(input, '9999999999999');
    expect(await screen.findByRole('alert')).toHaveTextContent('No product has the code “9999999999999”');
  });

  it('catches a scan made while the focus is outside any text box, and takes the focus back', async () => {
    mockApi({ 'GET /variants/by-code/4006381333931': () => json(200, { data: variant('d', 'SKU-D') }) });
    const onSelect = vi.fn();
    const input = renderPicker(onSelect, true);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();

    for (const ch of '4006381333931') fireEvent.keyDown(elsewhere, { key: ch });
    fireEvent.keyDown(elsewhere, { key: 'Enter' });

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU-D' }), '1'));
    expect(document.activeElement).toBe(input);
  });

  it('leaves slow, human key presses outside text boxes alone', async () => {
    const fetchMock = mockApi({});
    const onSelect = vi.fn();
    renderPicker(onSelect, true);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    const now = vi.spyOn(performance, 'now');
    let t = 0;
    now.mockImplementation(() => (t += 300)); // 300 ms between keys
    for (const ch of '12345') fireEvent.keyDown(elsewhere, { key: ch });
    fireEvent.keyDown(elsewhere, { key: 'Enter' });
    now.mockRestore();
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('VariantPicker with a Pieces box', () => {
  it('adds the number of pieces entered, then goes back to 1', async () => {
    mockApi({ 'GET /variants/by-code/5012345678900': () => json(200, { data: variant('c', 'SKU-C') }) });
    const onSelect = vi.fn();
    const input = renderPicker(onSelect, false, true);
    const pieces = screen.getByRole('textbox', { name: 'Pieces' }) as HTMLInputElement;

    fireEvent.change(pieces, { target: { value: '12' } });
    scanInto(input, '5012345678900');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU-C' }), '12'));
    expect(pieces.value).toBe('1');

    scanInto(input, '5012345678900');
    await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ sku: 'SKU-C' }), '1'));
  });

  it('reads an "N*" prefix typed before the scan', async () => {
    mockApi({ 'GET /variants/by-code/5012345678900': () => json(200, { data: variant('c', 'SKU-C') }) });
    const onSelect = vi.fn();
    const input = renderPicker(onSelect, false, true);

    fireEvent.change(input, { target: { value: '6*' } });
    scanInto(input, '5012345678900');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU-C' }), '6'));
  });

  it('takes a code scanned into the Pieces box as a scan of that many pieces', async () => {
    mockApi({ 'GET /variants/by-code/5012345678900': () => json(200, { data: variant('c', 'SKU-C') }) });
    const onSelect = vi.fn();
    renderPicker(onSelect, false, true);
    const pieces = screen.getByRole('textbox', { name: 'Pieces' }) as HTMLInputElement;

    const now = vi.spyOn(performance, 'now');
    let t = 0;
    now.mockImplementation(() => t);
    fireEvent.change(pieces, { target: { value: '4' } });
    t = 1000;
    scanInto(pieces, '5012345678900');
    now.mockRestore();

    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ sku: 'SKU-C' }), '4'));
  });

  it('refuses a scan when the Pieces box holds no number', async () => {
    const fetchMock = mockApi({});
    const onSelect = vi.fn();
    const input = renderPicker(onSelect, false, true);
    fireEvent.change(screen.getByRole('textbox', { name: 'Pieces' }), { target: { value: '0' } });
    scanInto(input, '5012345678900');
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the number of pieces');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
