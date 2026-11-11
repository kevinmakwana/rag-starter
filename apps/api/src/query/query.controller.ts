import { Body, Controller, HttpCode, Inject, Post, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
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
import { DemoSafe } from '../demo/demo-safe.decorator';
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from '../documents/tags';
import { Costly } from '../rate-limit/costly.decorator';
import { DocumentFilter, toInstant } from './document-filter';
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

  /** Restrict retrieval to documents with any of these tags. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(MAX_TAG_LENGTH, { each: true })
  tags?: string[];

  /** Restrict retrieval to documents whose source is exactly this. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  source?: string;

  /** Only documents indexed at or after / before this ISO 8601 date or date-time (send Z or an offset). */
  @IsOptional()
  @IsISO8601()
  createdAfter?: string;

  @IsOptional()
  @IsISO8601()
  createdBefore?: string;

  /** Earlier messages of this conversation, oldest first, used to resolve follow-up questions. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => HistoryMessageDto)
  history?: HistoryMessageDto[];
}

/** The filters of a request as the search wants them: tags cleaned, dates as instants. Throws a 400 for a bad one. */
function filterOf(dto: QueryDto): DocumentFilter {
  return {
    documentIds: dto.documentIds,
    tags: dto.tags?.length ? normalizeTags(dto.tags) : undefined,
    source: dto.source,
    createdAfter: dto.createdAfter ? toInstant('createdAfter', dto.createdAfter) : undefined,
    createdBefore: dto.createdBefore ? toInstant('createdBefore', dto.createdBefore) : undefined,
  };
}

@Controller('query')
export class QueryController {
  constructor(@Inject(QueryService) private readonly query: QueryService) {}

  @DemoSafe()
  @Costly()
  @Post()
  @HttpCode(200)
  ask(@Body() dto: QueryDto, @CurrentUser() owner: string): Promise<QueryResult> {
    return this.query.ask(dto.question.trim(), dto.topK, filterOf(dto), dto.history, owner);
  }

  /**
   * Same as POST /query, streamed as Server-Sent Events: `sources`, then `token`s,
   * then `done` (the full result). POST rather than GET because it carries a body.
   */
  @DemoSafe()
  @Costly()
  @Post('stream')
  @HttpCode(200)
  async stream(@Body() dto: QueryDto, @CurrentUser() owner: string, @Res() res: Response): Promise<void> {
    const filter = filterOf(dto); // a bad filter is a normal 400, before any SSE header is written
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
        filter,
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
