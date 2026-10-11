import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { QueryResult, QueryService } from './query.service';

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
}

@Controller('query')
export class QueryController {
  constructor(@Inject(QueryService) private readonly query: QueryService) {}

  @Post()
  @HttpCode(200)
  ask(@Body() dto: QueryDto): Promise<QueryResult> {
    return this.query.ask(dto.question.trim(), dto.topK, dto.documentIds);
  }
}
