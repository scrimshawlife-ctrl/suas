import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { ServiceRequestDetail } from '../../api/types';
import { EditRequestForm } from './EditRequestForm';
import { renderScreen } from './test-utils';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { POST: post } }));

const ID = '11111111-1111-4111-8111-111111111111';
const EDIT_PATH = '/api/v0/service-requests/{id}/commands/edit';

const ride = {
  service_request_id: ID,
  case_id: ID,
  category: 'TRANSPORTATION',
  status: 'MATCHING',
  summary: 'A ride to the clinic',
  timing: 'Thursday',
  meeting_place: 'Library steps',
  destination: 'Clinic',
} as ServiceRequestDetail;

const onDone = vi.fn();

function open(request: ServiceRequestDetail = ride) {
  renderScreen(<EditRequestForm request={request} onDone={onDone} />);
}

const editCalls = () =>
  post.mock.calls as [string, { headers: Record<string, string>; body: unknown }][];

async function replaceText(label: string | RegExp, text: string) {
  const field = screen.getByLabelText(label);
  await userEvent.clear(field);
  if (text !== '') await userEvent.type(field, text);
}

beforeEach(() => {
  post.mockReset();
  onDone.mockReset();
  post.mockResolvedValue({ data: { ...ride, replayed: false } });
});

describe('EditRequestForm', () => {
  it('is prefilled from the request with the category fixed', () => {
    open();
    expect(screen.getByLabelText('Short summary')).toHaveValue('A ride to the clinic');
    expect(screen.getByLabelText(/When do you need it/)).toHaveValue('Thursday');
    expect(screen.getByLabelText('Where should the helper meet you?')).toHaveValue('Library steps');
    expect(screen.getByLabelText(/Where are you going/)).toHaveValue('Clinic');
    expect(screen.getByLabelText('What kind of help do you need?')).toBeDisabled();
  });

  it('hides the destination for a request that is not a ride', () => {
    open({ ...ride, category: 'FOOD', destination: null });
    expect(screen.queryByLabelText(/Where are you going/)).not.toBeInTheDocument();
  });

  it('sends only the changed fields, null for a cleared one, with an Idempotency-Key', async () => {
    open();
    await replaceText('Short summary', 'A ride at 9 am');
    await replaceText(/Where are you going/, '');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(editCalls()).toHaveLength(1);
    const [path, options] = editCalls()[0] ?? ['', { headers: {}, body: null }];
    expect(path).toBe(EDIT_PATH);
    expect(options.body).toEqual({ summary: 'A ride at 9 am', destination: null });
    expect(options.headers['Idempotency-Key']).toBeTruthy();
  });

  it('closes without a request when nothing changed', async () => {
    open();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it('keeps the meeting place required for a ride, so it cannot be cleared', async () => {
    open();
    await replaceText('Where should the helper meet you?', '');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Tell us where the helper should meet you.'),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('says so on a 409 and stays open', async () => {
    post.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'Accepted already.'));
    open();
    await replaceText('Short summary', 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This changed while you were looking',
    );
    expect(onDone).not.toHaveBeenCalled();
  });

  it('says so on a 422 and reuses the key when the same edit is retried', async () => {
    post
      .mockRejectedValueOnce(new ApiError(422, 'UNPROCESSABLE', 'Not allowed.'))
      .mockResolvedValue({ data: { ...ride, replayed: false } });
    open();
    await replaceText('Short summary', 'Changed');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('needs another look');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const keys = editCalls().map((call) => call[1].headers['Idempotency-Key']);
    expect(keys[1]).toBe(keys[0]);
  });
});
