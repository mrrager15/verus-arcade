import express from 'express';

import { DailyServiceError } from './daily-service.mjs';
import { GENERIC_RESPONSE_QUERY_KEY } from './verus/requests.mjs';

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
    request.headers.authorization ?? '',
  );
  return match?.[1] ?? null;
}

export function createDailyRouter({
  dailyService,
  resolveSession,
  attemptSignatureService = null,
  playerPublicationService = null,
  walletReturnPath = '/',
}) {
  const router = express.Router();

  /**
   * Wallet-callbacks: geen sessie, de handtekening bewijst de afzender.
   * Vóór express.json: het POST-lichaam is binair (application/octet-stream).
   * `kind` komt in de landingspagina-URL zodat die weet wat er gebeurde.
   */
  function mountWalletCallbacks({ path, service, kind, statusOf }) {
    router.post(
      `/${path}/:requestId/response`,
      express.raw({ type: 'application/octet-stream', limit: '64kb' }),
      async (request, response, next) => {
        try {
          if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
            throw new DailyServiceError('INVALID_CALLBACK', 'Send a binary GenericResponse as application/octet-stream', 415);
          }
          const result = await service.acceptResponse({ requestIdHex: request.params.requestId, body: request.body });
          response.json({ accepted: true, replayed: result.replayed, status: statusOf(result) });
        } catch (error) {
          next(error);
        }
      },
    );

    router.get(`/${path}/:requestId/response`, async (request, response) => {
      // Redirect-transport: Mobile opent de browser met het antwoord in de query.
      // De bestemming krijgt alleen een code, nooit de bytes of een foutmelding.
      const destination = new URLSearchParams();
      const requestId = String(request.params.requestId);
      destination.set('walletReturn', /^[0-9a-f]{40}$/.test(requestId) ? requestId : 'invalid');
      destination.set('kind', kind);
      try {
        const query = new URL(request.originalUrl, 'http://callback.invalid').searchParams;
        const values = query.getAll(GENERIC_RESPONSE_QUERY_KEY);
        const encoded = values[0] ?? '';
        if (values.length !== 1 || encoded.length > 87_382 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
          throw new DailyServiceError('INVALID_CALLBACK', 'Invalid wallet response encoding', 400);
        }
        const body = Buffer.from(encoded, 'base64url');
        if (body.toString('base64url') !== encoded) {
          throw new DailyServiceError('INVALID_CALLBACK', 'Noncanonical wallet response encoding', 400);
        }
        const result = await service.acceptResponse({ requestIdHex: requestId, body });
        destination.set('signed', statusOf(result) === 'signed' || statusOf(result) === 'receipt' ? '1' : '0');
      } catch (error) {
        destination.set('returnError', error instanceof DailyServiceError ? error.code : 'INTERNAL_ERROR');
      }
      response.set('Cache-Control', 'no-store');
      response.set('Referrer-Policy', 'no-referrer');
      response.redirect(303, `${walletReturnPath}${walletReturnPath.includes('?') ? '&' : '?'}${destination.toString()}`);
    });
  }

  if (attemptSignatureService) {
    mountWalletCallbacks({ path: 'sign-jobs', service: attemptSignatureService, kind: 'sign', statusOf: (r) => r.signature.status });
  }
  if (playerPublicationService) {
    mountWalletCallbacks({ path: 'publish-jobs', service: playerPublicationService, kind: 'publish', statusOf: (r) => r.publication.status });
  }

  router.use(express.json({ limit: '4kb' }));

  router.get('/rounds/:roundId/proof', (request, response, next) => {
    try {
      response.json(dailyService.getRoundProof({ roundId: request.params.roundId }));
    } catch (error) {
      next(error);
    }
  });

  if (playerPublicationService) {
    // Publiek, zonder sessie: leest alleen van de chain.
    router.get('/profile/:iAddress', async (request, response, next) => {
      try {
        response.set('Cache-Control', 'public, max-age=30');
        response.json(await playerPublicationService.profile({ playerId: request.params.iAddress }));
      } catch (error) {
        next(error);
      }
    });
  }

  router.get('/games/word-grid/rounds/current', (_request, response) => {
    const round = dailyService.getCurrentRound();
    response.status(round ? 200 : 404).json(
      round
        ? { round }
        : {
            error: {
              code: 'ROUND_NOT_FOUND',
              message: 'No current Word Grid round is scheduled',
            },
          },
    );
  });

  router.get('/rounds/:roundId/leaderboard', (request, response, next) => {
    try {
      response.json(
        dailyService.getLeaderboard({ roundId: request.params.roundId }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.use((request, response, next) => {
    const token = bearerToken(request);
    const session = token ? resolveSession(token) : null;
    if (!session) {
      return response.status(401).json({
        error: {
          code: 'NOT_AUTHENTICATED',
          message: 'Authentication required',
        },
      });
    }
    request.principal = session.user;
    request.sessionExpiresAt = session.expiresAt;
    next();
  });

  router.get('/me', (request, response) => {
    response.json({
      principal: request.principal,
      sessionExpiresAt: request.sessionExpiresAt,
    });
  });

  router.post('/rounds/:roundId/attempts', (request, response, next) => {
    try {
      const result = dailyService.reserveAttempt({
        principal: request.principal,
        roundId: request.params.roundId,
      });
      response.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get('/rounds/:roundId/attempt', (request, response, next) => {
    try {
      response.json({
        attempt: dailyService.getRoundAttempt({
          principal: request.principal,
          roundId: request.params.roundId,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/attempts/:attemptId', (request, response, next) => {
    try {
      response.json({
        attempt: dailyService.getAttempt({
          principal: request.principal,
          attemptId: request.params.attemptId,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/attempts/:attemptId/proof', (request, response, next) => {
    try {
      response.json(
        dailyService.getAttemptProof({
          principal: request.principal,
          attemptId: request.params.attemptId,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  if (attemptSignatureService) {
    router.post('/attempts/:attemptId/sign-request', async (request, response, next) => {
      try {
        const result = await attemptSignatureService.createSignRequest({
          principal: request.principal,
          attemptId: request.params.attemptId,
        });
        response.status(result.created ? 201 : 200).json(result);
      } catch (error) {
        next(error);
      }
    });

    router.get('/attempts/:attemptId/sign-request', async (request, response, next) => {
      try {
        response.json(
          await attemptSignatureService.getSignRequest({
            principal: request.principal,
            attemptId: request.params.attemptId,
          }),
        );
      } catch (error) {
        next(error);
      }
    });
  }

  if (playerPublicationService) {
    router.post('/attempts/:attemptId/publish-request', async (request, response, next) => {
      try {
        const result = await playerPublicationService.createPublishRequest({
          principal: request.principal,
          attemptId: request.params.attemptId,
        });
        response.status(result.created ? 201 : 200).json(result);
      } catch (error) {
        next(error);
      }
    });

    router.get('/attempts/:attemptId/publish-request', async (request, response, next) => {
      try {
        response.json(
          await playerPublicationService.getPublishRequest({
            principal: request.principal,
            attemptId: request.params.attemptId,
          }),
        );
      } catch (error) {
        next(error);
      }
    });
  }

  router.post('/attempts/:attemptId/actions', (request, response, next) => {
    try {
      response.json(
        dailyService.submitAction({
          principal: request.principal,
          attemptId: request.params.attemptId,
          action: request.body,
        }),
      );
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _request, response, next) => {
    if (!(error instanceof DailyServiceError)) return next(error);
    response.status(error.httpStatus).json({
      error: { code: error.code, message: error.message },
    });
  });

  return router;
}
