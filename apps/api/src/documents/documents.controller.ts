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
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { extname } from 'path';
import { ExtractionError, extractText } from '../ingestion/extractors';
import { CreateDocumentDto, DocumentSummary, MAX_DOCUMENT_CHARS, MAX_UPLOAD_BYTES, titleFrom } from './documents.dto';
import { DocumentsService } from './documents.service';

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
    const ext = extname(file.originalname).toLowerCase();
    let content: string;
    try {
      content = await extractText(file.originalname, file.buffer);
    } catch (err) {
      if (err instanceof ExtractionError) throw new BadRequestException(err.message);
      throw err;
    }
    if (content.length > MAX_DOCUMENT_CHARS) throw new BadRequestException('File is too large');
    const title = titleFrom(content, file.originalname.slice(0, -ext.length) || file.originalname);
    return respondCreated(res, await this.documents.create({ title, content, source: file.originalname }));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', new ParseUUIDPipe()) id: string): Promise<void> {
    return this.documents.remove(id);
  }
}
