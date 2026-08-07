import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class UploadDocumentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  fileName!: string;

  /**
   * Advisory only — the server recomputes the real size from the decoded buffer.
   * A client-declared size cannot be allowed to gate a size limit.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  fileSize?: number;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  mimeType!: string;

  @IsString()
  @MinLength(1)
  fileBufferBase64!: string;
}

export class CrawlWebsiteDto {
  @IsString()
  @MinLength(4)
  @MaxLength(2048)
  url!: string;
}
