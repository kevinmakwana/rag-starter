import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ExtractionError } from '../ingestion/extractors';
import {
  CreateDocumentDto,
  DocumentDetail,
  DocumentSummary,
  MAX_UPLOAD_BYTES,
  UpdateDocumentDto,
} from './documents.dto';
import { DocumentsService, ReindexReport } from './documents.service';

/** 201 for a new document, 200 when identical content already existed. */
function respondCreated(res: Response, doc: DocumentSummary): DocumentSummary {
  if (doc.duplicate) res.status(200);
  return doc;
}

@Controller('documents')
export class DocumentsController {
  constructor(@Inject(DocumentsService) private readonly documents: DocumentsService) {}

  @Get()
  list(): Promise<DocumentSummary[]> {
    return this.documents.list();
  }

  /** Index pasted text. Responds 200 instead of 201 when the content was already indexed. */
  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary> {
    return respondCreated(res, await this.documents.create(dto));
  }

  /** Index an uploaded .md, .txt, .pdf or .docx file (multipart field name: "file"). */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<DocumentSummary> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    try {
      return respondCreated(res, await this.documents.ingestFile(file.originalname, file.buffer));
    } catch (err) {
      if (err instanceof ExtractionError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Re-index every document with the current chunking settings and embedding model. */
  @Post('reindex')
  @HttpCode(200)
  reindexAll(): Promise<ReindexReport> {
    return this.documents.reindexAll();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string): Promise<DocumentDetail> {
    return this.documents.get(id);
  }

  /** Change the title and/or text of a document; it is re-embedded. */
  @Put(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateDocumentDto): Promise<DocumentSummary> {
    return this.documents.update(id, dto);
  }

  /** Re-index one document from its stored text. */
  @Post(':id/reindex')
  @HttpCode(200)
  reindex(@Param('id', new ParseUUIDPipe()) id: string): Promise<DocumentSummary> {
    return this.documents.reindex(id);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(id);
  }
}
