/** Adapter Anthropic: phân loại lỗi — hết credit (400) phải là quota để công ty chuyển hãng và báo CEO. */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import { toLlmError } from './anthropic.js';

describe('toLlmError (Anthropic)', () => {
  it('400 "credit balance is too low" là hết tiền, không phải yêu cầu sai', () => {
    const error = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } },
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      new Headers(),
    );
    expect(toLlmError(error)).toMatchObject({ kind: 'quota', status: 400 });
  });

  it('400 thường vẫn là yêu cầu sai; 529 là quá tải', () => {
    expect(toLlmError(new Anthropic.BadRequestError(400, {}, 'max_tokens: must be less than 64000', new Headers()))).toMatchObject({ kind: 'invalid_request' });
    expect(toLlmError(new Anthropic.InternalServerError(529, {}, 'Overloaded', new Headers()))).toMatchObject({ kind: 'overloaded' });
  });
});
