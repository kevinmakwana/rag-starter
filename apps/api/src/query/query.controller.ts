import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import { Costly } from '../rate-limit/costly.decorator';
import { QueryResult, QueryService } from './query.service';
import { formatSseEvent } from './sse';

export class HistoryMessageDto {
  @IsIn(['user', 'assistant'])
  role: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content: string;
}

export class QueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  question: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  topK?: number;

  /** Restrict retrieval to these documents. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  documentIds?: string[];

  /** Earlier messages of this conversation, oldest first, used to resolve follow-up questions. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HistoryMessageDto)
  history?: HistoryMessageDto[];
}

@Controller('query')
export class QueryController {
  constructor(@Inject(QueryService) private readonly query: QueryService) {}

  @Costly()
  @Post()
  @HttpCode(200)
  ask(@Body() dto: QueryDto, @CurrentUser() owner: string): Promise<QueryResult> {
    return this.query.ask(dto.question.trim(), dto.topK, dto.documentIds, dto.history, owner);
  }

  /**
   * Same as POST /query, streamed as Server-Sent Events: `sources`, then `token`s,
   * then `done` (the full result). POST rather than GET because it carries a body.
   */
  @Costly()
  @Post('stream')
  @HttpCode(200)
  async stream(@Body() dto: QueryDto, @CurrentUser() owner: string, @Res() res: Response): Promise<void> {
    const abort = new AbortController();
    // Stop paying for tokens nobody is reading once the client goes away.
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });

    let opened = false;
    try {
      for await (const event of this.query.askStream(
        dto.question.trim(),
        dto.topK,
        dto.documentIds,
        abort.signal,
        dto.history,
        owner,
      )) {
        if (!opened) {
          opened = true;
          res.status(200).set({
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.flushHeaders();
        }
        const { type, ...data } = event;
        res.write(formatSseEvent(type, data));
      }
    } catch (err) {
      // Before the first event nothing has been sent, so let the exception filters answer (400/502/500).
      if (!opened) throw err;
      if (!abort.signal.aborted) res.write(formatSseEvent('error', { message: (err as Error).message }));
    }
    if (opened) res.end();
  }
}
