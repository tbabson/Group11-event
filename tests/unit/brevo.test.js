import { jest } from '@jest/globals';
import brevo from '../../src/services/brevo.client.js';

describe('brevo client', () => {
  it('parses "Name <email>" addresses', () => {
    expect(brevo.parseAddress('Events <no-reply@ev.dev>')).toEqual({ name: 'Events', email: 'no-reply@ev.dev' });
    expect(brevo.parseAddress('a@b.dev')).toEqual({ email: 'a@b.dev' });
  });

  it('maps a nodemailer-style message to the Brevo payload', () => {
    const payload = brevo.toPayload({
      from: 'Events <no-reply@ev.dev>',
      to: 'ada@test.dev',
      subject: 'Your ticket',
      html: '<p>Hi</p><img src="cid:ticket-qr" alt="QR">',
      attachments: [{ filename: 'ticket.png', content: Buffer.from('png-bytes'), cid: 'ticket-qr' }],
    });
    expect(payload).toEqual({
      sender: { name: 'Events', email: 'no-reply@ev.dev' },
      to: [{ email: 'ada@test.dev' }],
      subject: 'Your ticket',
      htmlContent: '<p>Hi</p>',
      attachment: [{ name: 'ticket.png', content: Buffer.from('png-bytes').toString('base64') }],
    });
  });

  it('posts to /smtp/email with the api-key header', async () => {
    const post = jest.spyOn(brevo.http, 'post').mockResolvedValue({ data: { messageId: '<abc@brevo>' } });
    const res = await brevo.sendMail({ to: 'a@b.dev', subject: 's', html: 'h' });
    expect(res).toEqual({ messageId: '<abc@brevo>' });
    expect(post).toHaveBeenCalledWith(
      '/smtp/email',
      expect.objectContaining({ subject: 's', to: [{ email: 'a@b.dev' }] }),
      expect.objectContaining({ headers: expect.objectContaining({ 'api-key': undefined }) })
    );
  });

  it('throws a clean error that does not carry the request config', async () => {
    const axiosErr = Object.assign(new Error('Request failed'), {
      response: { status: 401, data: { message: 'Key not found' } },
      config: { headers: { 'api-key': 'secret' } },
    });
    jest.spyOn(brevo.http, 'post').mockRejectedValue(axiosErr);
    const err = await brevo.sendMail({ to: 'a@b.dev', subject: 's', html: 'h' }).catch((e) => e);
    expect(err.message).toBe('Brevo send failed (401): Key not found');
    expect(err.config).toBeUndefined();
  });
});
