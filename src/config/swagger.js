// OpenAPI 3 description of the API, served at /api/docs.
const bearer = [{ bearerAuth: [] }];
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const json = (schema) => ({ required: true, content: { 'application/json': { schema } } });
const ok = (description = 'OK') => ({ description });
const errors = {
  400: { $ref: '#/components/responses/Error' },
  401: { $ref: '#/components/responses/Error' },
  403: { $ref: '#/components/responses/Error' },
  404: { $ref: '#/components/responses/Error' },
  409: { $ref: '#/components/responses/Error' },
};
const listParams = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } },
];

const obj = (properties, required = []) => ({ type: 'object', properties, required });
const str = { type: 'string' };
const int = { type: 'integer' };
const date = { type: 'string', format: 'date-time' };

export default {
  openapi: '3.0.3',
  info: {
    title: 'Event Registration & Management API',
    version: '1.0.0',
    description:
      'Organizers create events and ticket types. Attendees register (free) or pay with Paystack (paid). ' +
      'Errors always look like `{ success: false, error: { code, message, details } }`. ' +
      'Prices are in the smallest currency unit (kobo).',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    responses: {
      Error: {
        description: 'Error',
        content: {
          'application/json': {
            schema: obj({
              success: { type: 'boolean', example: false },
              error: obj({ code: str, message: str, details: { type: 'array', items: { type: 'object' } } }),
            }),
          },
        },
      },
    },
    schemas: {
      EventInput: obj(
        {
          title: str,
          description: str,
          category: str,
          venue: obj({ name: str, address: str, city: str }),
          onlineUrl: str,
          startAt: date,
          endAt: date,
          capacity: int,
          refundPolicy: { type: 'string', enum: ['none', 'full'] },
        },
        ['title', 'category', 'startAt', 'endAt', 'capacity']
      ),
      TicketInput: obj(
        {
          name: str,
          kind: { type: 'string', enum: ['free', 'regular', 'vip'] },
          price: { ...int, description: 'Smallest currency unit; 0 for free' },
          currency: { ...str, example: 'NGN' },
          quantity: int,
          saleStart: date,
          saleEnd: date,
        },
        ['name', 'kind', 'quantity']
      ),
    },
  },
  paths: {
    '/health': { get: { tags: ['Ops'], summary: 'Health check', responses: { 200: ok(), 503: ok('Database down') } } },
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Sign up (attendee or organizer)',
        requestBody: json(obj({ name: str, email: str, password: str, role: { type: 'string', enum: ['attendee', 'organizer'] } }, ['name', 'email', 'password'])),
        responses: { 201: ok('User and tokens'), ...errors },
      },
    },
    '/auth/login': {
      post: { tags: ['Auth'], summary: 'Log in', requestBody: json(obj({ email: str, password: str }, ['email', 'password'])), responses: { 200: ok('User and tokens'), ...errors } },
    },
    '/auth/refresh': {
      post: { tags: ['Auth'], summary: 'Rotate refresh token', requestBody: json(obj({ refreshToken: str }, ['refreshToken'])), responses: { 200: ok('New tokens'), ...errors } },
    },
    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke a refresh token', requestBody: json(obj({ refreshToken: str }, ['refreshToken'])), responses: { 200: ok() } },
    },
    '/auth/forgot-password': {
      post: { tags: ['Auth'], summary: 'Email a password reset link', requestBody: json(obj({ email: str }, ['email'])), responses: { 200: ok('Always 200') } },
    },
    '/auth/reset-password': {
      post: { tags: ['Auth'], summary: 'Set a new password with a reset token', requestBody: json(obj({ token: str, password: str }, ['token', 'password'])), responses: { 200: ok(), ...errors } },
    },
    '/me': { get: { tags: ['Me'], summary: 'Current user', security: bearer, responses: { 200: ok(), ...errors } } },
    '/me/registrations': {
      get: { tags: ['Me'], summary: 'My registrations', security: bearer, parameters: [...listParams, { name: 'status', in: 'query', schema: str }], responses: { 200: ok(), ...errors } },
    },
    '/events': {
      get: {
        tags: ['Events'],
        summary: 'Search published events',
        parameters: [
          ...listParams,
          { name: 'sort', in: 'query', schema: str, description: 'e.g. startAt, -createdAt, title' },
          { name: 'q', in: 'query', schema: str, description: 'Text search on title and description' },
          { name: 'category', in: 'query', schema: str },
          { name: 'city', in: 'query', schema: str },
          { name: 'from', in: 'query', schema: date },
          { name: 'to', in: 'query', schema: date },
          { name: 'minPrice', in: 'query', schema: int },
          { name: 'maxPrice', in: 'query', schema: int },
          { name: 'isFree', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: { 200: ok('Events with meta { page, limit, total }') },
      },
      post: { tags: ['Events'], summary: 'Create an event (draft)', security: bearer, requestBody: json({ $ref: '#/components/schemas/EventInput' }), responses: { 201: ok(), ...errors } },
    },
    '/events/{slug}': {
      get: { tags: ['Events'], summary: 'Event details with ticket types', parameters: [{ name: 'slug', in: 'path', required: true, schema: str }], responses: { 200: ok(), 404: errors[404] } },
    },
    '/events/{id}': {
      patch: { tags: ['Events'], summary: 'Update an event (owner)', security: bearer, parameters: [id], requestBody: json({ $ref: '#/components/schemas/EventInput' }), responses: { 200: ok(), ...errors } },
      delete: { tags: ['Events'], summary: 'Delete (no registrations) or cancel the event', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } },
    },
    '/events/{id}/publish': { post: { tags: ['Events'], summary: 'Publish', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } } },
    '/events/{id}/unpublish': { post: { tags: ['Events'], summary: 'Unpublish (no registrations)', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } } },
    '/events/{id}/banner': {
      post: {
        tags: ['Events'],
        summary: 'Upload banner image (multipart field "banner")',
        security: bearer,
        parameters: [id],
        requestBody: { content: { 'multipart/form-data': { schema: obj({ banner: { type: 'string', format: 'binary' } }) } } },
        responses: { 200: ok(), ...errors, 503: ok('Uploads not configured') },
      },
    },
    '/events/{id}/tickets': {
      post: { tags: ['Tickets'], summary: 'Add a ticket type', security: bearer, parameters: [id], requestBody: json({ $ref: '#/components/schemas/TicketInput' }), responses: { 201: ok(), ...errors } },
    },
    '/tickets/{id}': {
      patch: { tags: ['Tickets'], summary: 'Update a ticket type', security: bearer, parameters: [id], requestBody: json({ $ref: '#/components/schemas/TicketInput' }), responses: { 200: ok(), ...errors } },
    },
    '/events/{id}/register': {
      post: {
        tags: ['Registration'],
        summary: 'Register or buy a ticket',
        description: '201 confirmed (free) or pending with checkoutUrl (paid); 202 waitlisted when sold out.',
        security: bearer,
        parameters: [id],
        requestBody: json(obj({ ticketTypeId: str }, ['ticketTypeId'])),
        responses: { 201: ok('Confirmed or pending'), 202: ok('Waitlisted'), ...errors },
      },
    },
    '/registrations/{id}': {
      delete: { tags: ['Registration'], summary: 'Cancel a registration (attendee or organizer)', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } },
    },
    '/registrations/{id}/qr': {
      get: {
        tags: ['Registration'],
        summary: 'Download the ticket QR code as a PNG',
        description: 'Attendee (own ticket), event organizer or admin. Confirmed or checked-in registrations only.',
        security: bearer,
        parameters: [
          id,
          { name: 'size', in: 'query', schema: { type: 'integer', minimum: 150, maximum: 1000, default: 400 }, description: 'Image width in pixels' },
          { name: 'inline', in: 'query', schema: { type: 'boolean' }, description: 'true = show in the browser instead of downloading' },
        ],
        responses: {
          200: { description: 'PNG image', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
          ...errors,
        },
      },
    },
    '/payments/initialize': {
      post: { tags: ['Payments'], summary: 'Get a checkout URL for a pending registration', security: bearer, requestBody: json(obj({ registrationId: str }, ['registrationId'])), responses: { 200: ok(), ...errors } },
    },
    '/payments/webhook': {
      post: {
        tags: ['Payments'],
        summary: 'Paystack webhook (x-paystack-signature required)',
        parameters: [{ name: 'x-paystack-signature', in: 'header', required: true, schema: str }],
        responses: { 200: ok('Processed or duplicate'), 401: errors[401] },
      },
    },
    '/payments/demo/checkout/{reference}': {
      get: {
        tags: ['Payments'],
        summary: 'Demo checkout page (PAYSTACK_MODE=demo only)',
        parameters: [{ name: 'reference', in: 'path', required: true, schema: str }],
        responses: { 200: { description: 'HTML page with Pay / Decline buttons', content: { 'text/html': {} } }, 404: errors[404] },
      },
    },
    '/payments/demo/checkout/{reference}/complete': {
      post: {
        tags: ['Payments'],
        summary: 'Simulate the Paystack result for a demo checkout',
        description: 'Builds and signs a charge.success / charge.failed webhook and runs it through the real webhook handler.',
        parameters: [{ name: 'reference', in: 'path', required: true, schema: str }],
        requestBody: json(obj({ outcome: { type: 'string', enum: ['success', 'failed'] } }, ['outcome'])),
        responses: { 200: ok('Webhook result, e.g. { outcome, confirmed: true }'), 400: errors[400], 404: errors[404] },
      },
    },
    '/events/{id}/check-in': {
      post: { tags: ['Check-in'], summary: 'Scan a QR token', security: bearer, parameters: [id], requestBody: json(obj({ qrToken: str }, ['qrToken'])), responses: { 200: ok(), ...errors } },
    },
    '/events/{id}/attendees': {
      get: { tags: ['Reports'], summary: 'Attendee list', security: bearer, parameters: [id, ...listParams, { name: 'status', in: 'query', schema: str }], responses: { 200: ok(), ...errors } },
    },
    '/events/{id}/attendees.csv': {
      get: { tags: ['Reports'], summary: 'Attendee CSV export', security: bearer, parameters: [id], responses: { 200: { description: 'CSV', content: { 'text/csv': {} } }, ...errors } },
    },
    '/events/{id}/stats': {
      get: { tags: ['Reports'], summary: 'Registrations, revenue, check-in rate', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } },
    },
    '/me/payout-account': {
      put: {
        tags: ['Payouts'],
        summary: 'Set the bank account organizer payouts are sent to',
        security: bearer,
        requestBody: json(obj({ bankCode: { ...str, example: '058' }, accountNumber: { ...str, example: '0123456789' }, accountName: str }, ['bankCode', 'accountNumber', 'accountName'])),
        responses: { 200: ok('User with masked payoutAccount'), ...errors },
      },
    },
    '/me/payouts': {
      get: { tags: ['Payouts'], summary: 'My payouts (organizer)', security: bearer, parameters: [...listParams, { name: 'status', in: 'query', schema: str }], responses: { 200: ok(), ...errors } },
    },
    '/admin/payouts': {
      get: { tags: ['Admin'], summary: 'All payouts', security: bearer, parameters: [...listParams, { name: 'status', in: 'query', schema: str }], responses: { 200: ok(), ...errors } },
    },
    '/admin/payouts/{id}/retry': {
      post: { tags: ['Admin'], summary: 'Retry a failed or awaiting_account payout', security: bearer, parameters: [id], responses: { 200: ok(), ...errors } },
    },
    '/admin/revenue': {
      get: {
        tags: ['Admin'],
        summary: 'Platform fee revenue and payout totals',
        security: bearer,
        parameters: [{ name: 'from', in: 'query', schema: date }, { name: 'to', in: 'query', schema: date }],
        responses: { 200: ok(), ...errors },
      },
    },
    '/admin/users': {
      get: { tags: ['Admin'], summary: 'List users', security: bearer, parameters: [...listParams, { name: 'role', in: 'query', schema: str }, { name: 'q', in: 'query', schema: str }], responses: { 200: ok(), ...errors } },
    },
    '/admin/events/{id}/status': {
      patch: {
        tags: ['Admin'],
        summary: 'Set any event status',
        security: bearer,
        parameters: [id],
        requestBody: json(obj({ status: { type: 'string', enum: ['draft', 'published', 'cancelled', 'completed'] } }, ['status'])),
        responses: { 200: ok(), ...errors },
      },
    },
  },
};
