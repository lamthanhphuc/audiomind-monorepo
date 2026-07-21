package com.example.processingservice.config;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;

class StartupConfigValidatorTest {

    private static void setJwt(StartupConfigValidator validator, String value) throws Exception {
        Field field = StartupConfigValidator.class.getDeclaredField("jwtSecret");
        field.setAccessible(true);
        field.set(validator, value);
    }

    @Test
    void acceptsJwtSecretAtLeast32Characters() throws Exception {
        StartupConfigValidator validator = new StartupConfigValidator();
        setJwt(validator, "development-jwt-secret-at-least-32-characters");
        assertDoesNotThrow(() -> validator.run(new DefaultApplicationArguments()));
    }

    @Test
    void rejectsMissingJwtSecret() throws Exception {
        StartupConfigValidator validator = new StartupConfigValidator();
        setJwt(validator, "");
        IllegalStateException ex = assertThrows(
                IllegalStateException.class,
                () -> validator.run(new DefaultApplicationArguments())
        );
        assertTrue(ex.getMessage().contains("JWT_SECRET"));
    }

    @Test
    void rejectsShortJwtSecret() throws Exception {
        StartupConfigValidator validator = new StartupConfigValidator();
        setJwt(validator, "short");
        IllegalStateException ex = assertThrows(
                IllegalStateException.class,
                () -> validator.run(new DefaultApplicationArguments())
        );
        assertTrue(ex.getMessage().contains("JWT_SECRET"));
    }
}
