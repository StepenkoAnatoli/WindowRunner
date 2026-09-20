import {
  createInitialTurnState,
  reduceTurnState,
  type StreamEvent,
  type TurnState,
} from "@windows-runner/shared";

export type TurnUiState = TurnState;

export const initialTurnState: TurnUiState = createInitialTurnState();

export function applyEvent(state: TurnUiState, event: StreamEvent): TurnUiState {
  return reduceTurnState(state, event);
}
