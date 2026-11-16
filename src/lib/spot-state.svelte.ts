// What the spotlight (VoiceStage) tells the player inside it: the YouTube overlay shows the pop-out
// and full screen buttons itself while the spotlight is full screen (the spotlight's own bar is
// hidden for it then), and asks for them with the 'libertad-spot' event.
// call: the player is in a friend call's stage (CallStage), which handles full screen itself and has no pop out
export const spotState = $state({ fullscreen: false, poppedOut: false, call: false });
export const spotAction = (action: 'fullscreen' | 'popout') =>
  window.dispatchEvent(new CustomEvent('libertad-spot', { detail: action }));
