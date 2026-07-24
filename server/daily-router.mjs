import express from 'express';

import { DailyServiceError } from './daily-service.mjs';

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(
    request.headers.authorization ?? '',
  );
  return match?.[1] ?? null;
}

export function createDailyRouter({ dailyService, resolveSession }) {
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }));

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

  router.use((error, _request, response, next) => {
    if (!(error instanceof DailyServiceError)) return next(error);
    response.status(error.httpStatus).json({
      error: { code: error.code, message: error.message },
    });
  });

  return router;
}
