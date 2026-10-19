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
import { CurrentUser } from '../auth/current-user.decorator';
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
  list(@CurrentUser() owner: string): Promise<DocumentSummary[]> {
    return this.documents.list(owner);
  }

  /** Index pasted text. Responds 200 instead of 201 when the content was already indexed. */
  @Post()
  async create(
    @Body() dto: CreateDocumentDto,
    @CurrentUser() owner: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary> {
    return respondCreated(res, await this.documents.create(dto, owner));
  }

  /** Index an uploaded .md, .txt, .pdf or .docx file (multipart field name: "file"). */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async upload(
    @CurrentUser() owner: string,
    @Res({ passthrough: true }) res: Response,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<DocumentSummary> {
    if (!file) throw new BadRequestException('Attach a file in the "file" field');
    try {
      return respondCreated(res, await this.documents.ingestFile(file.originalname, file.buffer, owner));
    } catch (err) {
      if (err instanceof ExtractionError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /** Re-index every document with the current chunking settings and embedding model. */
  @Post('reindex')
  @HttpCode(200)
  reindexAll(@CurrentUser() owner: string): Promise<ReindexReport> {
    return this.documents.reindexAll(owner);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() owner: string): Promise<DocumentDetail> {
    return this.documents.get(id, owner);
  }

  /** Change the title and/or text of a document; it is re-embedded. */
  @Put(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDocumentDto,
    @CurrentUser() owner: string,
  ): Promise<DocumentSummary> {
    return this.documents.update(id, dto, owner);
  }

  /** Re-index one document from its stored text. */
  @Post(':id/reindex')
  @HttpCode(200)
  reindex(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() owner: string): Promise<DocumentSummary> {
    return this.documents.reindex(id, owner);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() owner: string): Promise<void> {
    return this.documents.remove(id, owner);
  }
}
