import { IsString } from 'class-validator';

export class LoginDto {
  // The pre-shared admin key. Length is not constrained here — wrong-length
  // input is the most common failure mode and we want to re-render the login
  // page with a friendly error, not the 422 JSON the validation pipe emits.
  @IsString()
  key!: string;
}
