import { InvariantViolationError } from '../shared/domain-error';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de "já recebi a mensagem X neste consumidor".
 * Chave única no banco: (consumer_name, message_id).
 *
 * É gravado na MESMA transação SQL que a alteração financeira. Se a mensagem
 * for entregue de novo pelo SQS (at-least-once), o consumidor encontra a linha
 * e só faz o ack, sem reprocessar.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName) {
      throw new InvariantViolationError('Inbox message requires messageId and consumerName');
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvariantViolationError(`Inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }

  toState(): InboxMessageState {
    return {
      messageId: this.messageId,
      consumerName: this.consumerName,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this._processedAt,
    };
  }
}
