import { ActionData, ActionType } from '@app/classes/communication/action-data';
import { FeedbackMessage, FeedbackMessages } from '@app/classes/communication/feedback-messages';
import { GameUpdateData } from '@app/classes/communication/game-update-data';
import { Message } from '@app/classes/communication/message';
import { GameRequest } from '@app/classes/communication/request';
import { HttpException } from '@app/classes/http-exception/http-exception';
import { CONTENT_REQUIRED, SENDER_REQUIRED } from '@app/constants/controllers-errors';
import { INVALID_WORD_TIMEOUT, IS_OPPONENT, SYSTEM_ERROR_ID, SYSTEM_ID } from '@app/constants/game-constants';
import { COMMAND_IS_INVALID, OPPONENT_PLAYED_INVALID_WORD } from '@app/constants/services-errors';
import { ActiveGameService } from '@app/services/active-game-service/active-game.service';
import { GamePlayService } from '@app/services/game-play-service/game-play.service';
import { SocketService } from '@app/services/socket-service/socket.service';
import { VirtualPlayerService } from '@app/services/virtual-player-service/virtual-player.service';
import { Delay } from '@app/utils/delay/delay';
import { isIdVirtualPlayer } from '@app/utils/is-id-virtual-player/is-id-virtual-player';
import { Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { Service } from 'typedi';

@Service()
export class GamePlayController {
    router: Router;

    constructor(
        private readonly gamePlayService: GamePlayService,
        private readonly socketService: SocketService,
        private readonly activeGameService: ActiveGameService,
        private readonly virtualPlayerService: VirtualPlayerService,
    ) {
        this.configureRouter();
    }

    private configureRouter(): void {
        this.router = Router();

        this.router.post('/games/:gameId/players/:playerId/action', async (req: GameRequest, res: Response) => {
            const { gameId, playerId } = req.params;
            const data: ActionData = req.body;

            try {
                await this.handlePlayAction(gameId, playerId, data);
                res.status(StatusCodes.NO_CONTENT).send();
            } catch (exception) {
                HttpException.sendError(exception, res);
            }
        });

        this.router.post('/games/:gameId/players/:playerId/message', (req: GameRequest, res: Response) => {
            const gameId = req.params.gameId;
            const message: Message = req.body;

            try {
                this.handleNewMessage(gameId, message);
                res.status(StatusCodes.NO_CONTENT).send();
            } catch (exception) {
                HttpException.sendError(exception, res);
            }
        });

        this.router.post('/games/:gameId/players/:playerId/error', (req: GameRequest, res: Response) => {
            const { playerId, gameId } = req.params;
            const message: Message = req.body;

            try {
                this.handleNewError(playerId, gameId, message);
                res.status(StatusCodes.NO_CONTENT).send();
            } catch (exception) {
                HttpException.sendError(exception, res);
            }
        });
    }

    private async handlePlayAction(gameId: string, playerId: string, data: ActionData): Promise<void> {
        if (data.type === undefined) throw new HttpException('type is required', StatusCodes.BAD_REQUEST);
        if (data.payload === undefined) throw new HttpException('payload is required', StatusCodes.BAD_REQUEST);

        try {
            if (data.input.length > 0) {
                this.socketService.emitToSocket(playerId, 'newMessage', {
                    content: data.input,
                    senderId: playerId,
                    gameId,
                });
            }

            const [updateData, feedback] = await this.gamePlayService.playAction(gameId, playerId, data);

            if (updateData) {
                this.gameUpdate(gameId, updateData);
            }
            if (feedback) {
                this.handleFeedback(gameId, playerId, feedback);
            }
        } catch (exception) {
            // If the error is generated by the Virtual Player, we do not want to handle the error as usual,
            // because this would mean sending a message to the client to tell them the error
            // We simply want to propagate the error so the Virtual Player sees its action has failed
            if (isIdVirtualPlayer(playerId)) throw new HttpException((exception as HttpException).message, (exception as HttpException).status);

            await this.handleError(exception, data.input, playerId, gameId);

            if (this.isWordNotInDictionaryError(exception)) {
                if (this.gamePlayService.isGameOver(gameId, playerId)) return;

                await this.handlePlayAction(gameId, playerId, { type: ActionType.PASS, payload: {}, input: '' });
            }
        }
    }

    private gameUpdate(gameId: string, data: GameUpdateData): void {
        this.socketService.emitToRoom(gameId, 'gameUpdate', data);
        if (data.round && isIdVirtualPlayer(data.round.playerData.id)) {
            this.virtualPlayerService.triggerVirtualPlayerTurn(data, this.activeGameService.getGame(gameId, data.round.playerData.id));
        }
    }

    private handleFeedback(gameId: string, playerId: string, feedback: FeedbackMessages): void {
        if (feedback.localPlayerFeedback.message) {
            this.socketService.emitToSocket(playerId, 'newMessage', {
                content: feedback.localPlayerFeedback.message,
                senderId: SYSTEM_ID,
                gameId,
                isClickable: feedback.localPlayerFeedback.isClickable,
            });
        }
        if (feedback.opponentFeedback.message) {
            const opponentId = this.activeGameService.getGame(gameId, playerId).getPlayer(playerId, IS_OPPONENT).id;
            this.socketService.emitToSocket(opponentId, 'newMessage', {
                content: feedback.opponentFeedback.message,
                senderId: SYSTEM_ID,
                gameId,
                isClickable: feedback.opponentFeedback.isClickable,
            });
        }
        if (feedback.endGameFeedback.length > 0) {
            this.socketService.emitToRoom(gameId, 'newMessage', {
                content: feedback.endGameFeedback.map((feedbackMesssage: FeedbackMessage) => feedbackMesssage.message ?? '').join('<br>'),
                senderId: SYSTEM_ID,
                gameId,
            });
        }
    }

    private handleNewMessage(gameId: string, message: Message): void {
        if (message.senderId === undefined) throw new HttpException(SENDER_REQUIRED, StatusCodes.BAD_REQUEST);
        if (message.content === undefined) throw new HttpException(CONTENT_REQUIRED, StatusCodes.BAD_REQUEST);

        this.socketService.emitToRoom(gameId, 'newMessage', message);
    }

    private handleNewError(playerId: string, gameId: string, message: Message): void {
        if (message.senderId === undefined) throw new HttpException(SENDER_REQUIRED, StatusCodes.BAD_REQUEST);
        if (message.content === undefined) throw new HttpException(CONTENT_REQUIRED, StatusCodes.BAD_REQUEST);

        this.socketService.emitToSocket(playerId, 'newMessage', {
            content: message.content,
            senderId: SYSTEM_ERROR_ID,
            gameId,
        });
    }

    private async handleError(exception: Error, input: string, playerId: string, gameId: string): Promise<void> {
        if (this.isWordNotInDictionaryError(exception)) {
            await Delay.for(INVALID_WORD_TIMEOUT);

            if (this.gamePlayService.isGameOver(gameId, playerId)) return;

            this.gameUpdate(gameId, this.gamePlayService.handleResetObjectives(gameId, playerId));

            const opponentId = this.activeGameService.getGame(gameId, playerId).getPlayer(playerId, IS_OPPONENT).id;
            this.socketService.emitToSocket(opponentId, 'newMessage', {
                content: OPPONENT_PLAYED_INVALID_WORD,
                senderId: SYSTEM_ID,
                gameId,
            });
        }

        this.socketService.emitToSocket(playerId, 'newMessage', {
            content: COMMAND_IS_INVALID(input) + exception.message,
            senderId: SYSTEM_ERROR_ID,
            gameId,
        });
    }

    private isWordNotInDictionaryError(exception: Error): boolean {
        return exception.message.includes(" n'est pas dans le dictionnaire choisi.");
    }
}
