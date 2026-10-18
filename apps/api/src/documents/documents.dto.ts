import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_DOCUMENT_CHARS = 500_000;
/** Size limit for an uploaded file (a PDF or Word file is bigger than the text inside it). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export class CreateDocumentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_DOCUMENT_CHARS)
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  source?: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  source: string;
  charCount: number;
  chunkCount: number;
  createdAt: string;
  /** True when identical content was already indexed and the existing document is returned. */
  duplicate: boolean;
}

/** Use the first Markdown H1 as the title, falling back to the file name. */
export function titleFrom(content: string, fallback: string): string {
  const h1 = content.match(/^#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
  return (h1 || fallback).slice(0, 200);
}
