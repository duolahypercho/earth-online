export class CDTError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CDTError';
    }
}
export class ConstraintRecoveryError extends CDTError {
    constructor(message) {
        super(message);
        this.name = 'ConstraintRecoveryError';
    }
}
export class DegenerateInputError extends CDTError {
    constructor(message) {
        super(message);
        this.name = 'DegenerateInputError';
    }
}
//# sourceMappingURL=types.js.map