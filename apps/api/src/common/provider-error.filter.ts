import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { Response } from 'express';

/** Turn upstream LLM failures into a clear 502 instead of an opaque 500. */
@Catch(OpenAI.APIError, Anthropic.APIError)
export class ProviderErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProviderError');

  catch(err: InstanceType<typeof OpenAI.APIError> | InstanceType<typeof Anthropic.APIError>, host: ArgumentsHost) {
    this.logger.error(`${err.status ?? '?'} ${err.message}`);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(502)
      .json({ statusCode: 502, error: 'Bad Gateway', message: `LLM provider error: ${err.message}` });
  }
}
